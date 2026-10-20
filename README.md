# msync

A private watch party for two. The host uploads a film once. Both people stream the same
full-quality file from the VPS, kept in sync to within tens of milliseconds, with a camera
call, chat, and a fullscreen overlay on top.

It replaces Discord screen share. The host's machine no longer re-encodes and uploads the
film, so the viewer's quality depends only on their own download speed. A slow link makes the
room buffer longer before it starts; it never lowers the quality.

```
            ┌──────────────────────── VPS (docker compose) ─────────────────────────┐
 Browser ──►│ web    Caddy :80/:443 — HTTPS (Let's Encrypt), HTTP/2+3, the app,     │
  (both)    │        /media/* straight from disk after forward_auth → api           │
            │ api    FastAPI, one process: rooms, admit flow, sync state, chat,     │
            │        call signaling over one WebSocket per person; SQLite           │
            │ tusd   resumable uploads (/files/) → /data/incoming                   │
            │ worker ffprobe + ffmpeg -c copy → single-rendition fMP4 HLS (nice 19) │
            │ coturn TURN relay for the call when NAT blocks a direct path          │
            └───────────────────────────────────────────────────────────────────────┘
 Film:    HTTPS GETs of 6 s HLS segments (static files, cached on each device)
 Control: WebSocket — intents, commands, status, clock pings, chat, WebRTC signaling
 Call:    WebRTC peer to peer (TURN only if needed), camera capped at 500 kbps
```

Contents:
[What was decided and why](#what-was-decided-and-why) ·
[Deploy on the VPS](#deploy-on-the-vps) ·
[Using it](#using-it) ·
[Run locally](#run-locally) ·
[Sync protocol](#sync-protocol) ·
[Tests](#tests) ·
[Real-device checklist](#real-device-checklist) ·
[Risks and unknowns](#risks-and-unknowns) ·
[Troubleshooting](#troubleshooting)

---

## What was decided and why

These were verified in October 2026; sources are at the end.

| Topic | Decision |
|---|---|
| Delivery | **Single-rendition fMP4 HLS, made with `ffmpeg -c copy`**: the original video bytes, never re-encoded. With one rendition, quality cannot drop. Played by **hls.js everywhere**: MSE on desktop and iPad, **ManagedMediaSource on iPhone (iOS 17.1+)**, native HLS only as a fallback. hls.js gives explicit buffer control (up to 180 s ahead, 90 s on iPhone), which a progressive MP4 never gets on iOS. |
| Live transcoding | **Never.** The worker copies H.264/HEVC video. It re-encodes only audio that browsers can't play (AC-3, DTS, TrueHD → AAC stereo; a few CPU-minutes per film). Unplayable video (AV1, VC-1, 10-bit H.264) is flagged. The host can then run `tools/encode-at-home.sh`, or approve a slow server re-encode. |
| Prebuffer | The worker records every segment's size. Each client measures its throughput and computes the **exact** buffer needed so playback never runs dry at that speed (`wait = max(downloadEnd_i − start_i)`), which accounts for bitrate peaks, not just the average. |
| Sync | Server-authoritative, sequence-numbered **intents** (not media events, so echo loops can't happen). A **ready barrier** precedes every play and seek. A **stall pauses everyone**. Starts are scheduled on a shared clock (NTP-style, lowest-RTT of 8 samples, re-measured every 10 s and on reconnect or visibility change). |
| Drift on Safari | **No playbackRate nudging on WebKit.** Rate changes stall about 90–300 ms and warp pitch there (WebKit 163433, 225868). Ahead drift is fixed with a micro-pause; behind drift with a seek that leads by the learned seek time. Chromium and Firefox nudge the rate by ±5%. |
| HTTPS without a domain | **sslip.io**: `203-0-113-7.sslip.io` resolves to that IP, with no account. Caddy gets a normal Let's Encrypt certificate by itself. Fallback: **a Let's Encrypt certificate for the bare IP** (generally available since 15 Jan 2026; lasts 6 days, renewed by Caddy 2.11). Switch with `CADDYFILE=Caddyfile.ip`. DuckDNS also works but needs an account and token. |
| Fullscreen | **iPad and desktop**: the whole stage element goes fullscreen, so the overlay (chat, mic, camera) stays. **iPhone** still has no element fullscreen, so the stage is already edge-to-edge (immersive mode). Add to Home Screen gives true full screen with the same overlay. Native iOS video fullscreen is never used, because it would hide the overlay. |
| Call | WebRTC P2P with perfect negotiation (the guest is polite), H.264 preferred (Safari hardware), camera 640×480 at 24 fps capped at 500 kbps. TURN uses coturn on the VPS with ephemeral HMAC credentials. |
| iOS audio | `navigator.audioSession.type = "play-and-record"` is set **at the Join tap, before the film plays**. Opening the mic switches iOS to play-and-record, which otherwise drops or reroutes the film's sound mid-movie (WebKit 236219). |
| Echo | Safari and Firefox echo-cancel all page audio. **Chrome cancels only the WebRTC audio**, so on Chrome with speakers the film leaks into the mic. The app recommends headphones and ducks the film to 40% while the friend talks (desktop; iOS doesn't allow setting volume from code). |
| Uploads | tusd (resumable, 32 MB chunks); an interrupted upload resumes when the same file is chosen again, and a Wake Lock keeps the screen on. **Import by URL** lets the VPS download a file directly, skipping the 5 Mbps home upload. |
| Storage | SQLite. Two people and a handful of films don't need Postgres's RAM. |
| Stack | FastAPI (one process holds the room state) · Preact + TypeScript + Vite · hls.js · tus-js-client · Caddy 2.11 · tusd 2.10 · coturn 4.18. |
| UI | Designed with [taste-skill](https://github.com/leonxlnx/taste-skill)'s app-screen run. The style is `true-black-flat` (seed 1554273): elevation by lightness alone, colour only on data, with one data hue (projector amber). The signature element is the **sync lanes**: each person as a lane along the film, with their buffer, playhead and drift in ms. |

## Deploy on the VPS

The VPS here is Ubuntu 24.04, 2 vCPU, 3.8 GB RAM, 84 GB disk, in Singapore, with Docker installed.

1. **Prepare the box** (as root, once): `bash tools/vps-setup.sh`.
   It installs updates and `unattended-upgrades`, plus the compose plugin. It also adds 2 GB of swap and opens the firewall:
   - 22/tcp, 80/tcp, 443/tcp+udp
   - 3478/tcp+udp, 49160–49200/udp

   **Also check GoDaddy's own firewall** in its panel, if your plan has one, and open the same ports there.
   Use SSH keys and disable password login (`PasswordAuthentication no` in `/etc/ssh/sshd_config`).

2. **Measure the route before trusting it.** On the VPS run `iperf3 -s`. From home run `iperf3 -c <VPS-IP> -R -t 20`, which measures VPS → you, the direction films travel.
   Also look up the plan's **monthly bandwidth allowance** in the GoDaddy panel. Each watch costs about **2 × the film's size** in egress (both of you stream it): a 4 GB film is 8 GB.

3. **Get the code and configure it**:
   ```bash
   sudo mkdir -p /srv && cd /srv && sudo git clone <your repo> msync && cd msync
   cp .env.example .env
   openssl rand -hex 32   # paste as SESSION_SECRET
   openssl rand -hex 32   # paste as TURN_SECRET
   nano .env              # SITE_ADDRESS=<ip-with-dashes>.sslip.io, PUBLIC_IP=<ip>
   docker compose build
   docker compose run --rm api python -m app.hashpw   # paste the printed line into .env
   ```

4. **Start**: `docker compose up -d`. Then watch the certificate arrive with `docker compose logs -f web` (look for "certificate obtained successfully").

5. Open `https://<ip-with-dashes>.sslip.io`, sign in as host, and open **Speed test**. Have your friend open their invite link and check theirs too.

Updates: `git pull && docker compose up -d --build`. Back up the `data` volume's `msync.db` if you care about room and chat history. The films can always be re-uploaded.

**If sslip.io is ever unreachable**, set `SITE_ADDRESS=<plain IP>` and `CADDYFILE=Caddyfile.ip`, then run `docker compose up -d`. Caddy then gets a 6-day IP certificate and renews it itself. A cheap domain (a few dollars a year) is the most robust option of all: point an A record at the VPS and put it in `SITE_ADDRESS`.

## Using it

1. **Add a film** (Movie nights → Add a film): choose a file (MKV/MP4/MOV), or paste a direct link and the server downloads it.
   The worker probes and packages it, which takes minutes and copies the video without re-encoding.
   If the file has several audio tracks, you pick one first. If its video can't play in browsers, the library says so, and you can either:
   - run `tools/encode-at-home.sh film.mkv` and upload the result, or
   - choose **Re-encode on server** (hours on 2 vCPUs).
2. **New room** → pick the film → **Copy invite link** and send it.
3. Your friend opens the link, types a name, and taps **Ask to join**. You see **Let in / Deny** on the home page, and as a banner inside the room.
4. Both of you see the **Join** card: a connection check against the film's peak bitrate, plus camera and mic choices. Tapping Join is the gesture that unlocks sound, the camera, and (on iOS) the audio session.
5. Either of you can play, pause, seek, or skip ±10 s, and it applies to both.
   - Keys: `space` play/pause · `←/→` 10 s · `f` fullscreen · `c` chat · `m` mic · `v` camera · `d` debug panel.
6. **iPhone**: Share → **Add to Home Screen**, then open msync from the icon for real full screen with the overlay.

## Run locally

```bash
# backend unit + protocol tests
cd backend && python3 -m venv .venv && .venv/bin/pip install -e '.[dev]' && .venv/bin/pytest

# frontend unit tests, typecheck, build
cd frontend && npm ci && npm test && npm run build

# the whole stack at https://localhost (Caddy's local CA; accept the warning)
cp .env.example .env   # set SITE_ADDRESS=localhost and DEV_ADMIN_PASSWORD=localtest123
docker compose up -d --build api worker tusd web
```

`DEV_ADMIN_PASSWORD` is a plain-text password for local use only. In production use `ADMIN_PASSWORD_HASH`.

## Sync protocol

The server's `backend/app/sync/room_state.py` is a pure state machine with an injected clock, so every rule below is unit-tested.

- **Room state**:
  - `seq`, `phase` (paused | preparing | playing) and `pos`,
  - `anchor` (the server-ms time at which `pos` holds),
  - `want_playing` and `min_ahead`.
  - While playing, the room's position is `pos + (serverNow − anchor)/1000`.
- **Client → server**: `ping`, `intent{play|pause|seek, base_seq}`, `status{seq, state, pos, ahead, rtt, drift, mbps}`, `chat`, `typing`, `rtc`, `media_state`, `resync`.
- **Server → client**: `pong{t0,t1,t2}`, `snapshot`, `cmd{prepare|start|pause, seq}`, `presence`, `notice`, `chat`, `knocks` (host only).

Rules:

1. **Intents, not events.** Only user actions are sent, plus system pauses such as AirPods coming out or a phone call. A command being applied is never re-broadcast.
2. **Stale drop.** An intent with `base_seq < seq` is rejected, and that person is re-synced. A command older than the last one applied is ignored.
3. **Ready barrier.** Every play, and every seek while playing, runs this sequence:
   - `prepare(pos)`; each side pauses, seeks, and buffers its computed target, then reports ready.
   - `start(pos, at = now + max(400 ms, 2 × max RTT))`, and both sides start on the same server millisecond.
   - After 30 s, everyone is told who they're waiting for, and the host can **Start without waiting**.
4. **Stall pauses everyone.** A client stuck in `waiting` for more than 300 ms reports `buffering`. The room pauses at that person's position and re-runs the barrier with 1.5× more buffer.
5. **Seek on release.** Scrubbing previews locally. Keyboard steps are coalesced over 400 ms into one seek.
6. **Reconnect.** The socket reconnects with backoff (immediately on returning to the tab). The server sends a snapshot and the client converges. A short drop doesn't pause anyone.
7. **Drift ladder** (checked every 250 ms, 2 s cooldown):

   | Drift | Chromium / Firefox | Safari / iOS |
   |---|---|---|
   | < 60 ms | nothing | nothing |
   | 60 ms – 1 s | rate 0.95 / 1.05 until within 20 ms | micro-pause if ahead · lead-seek if behind |
   | > 1 s | seek | seek |
   | 4th correction in a minute | full barrier for everyone | same |

   `?sync=rate` or `?sync=safari` on the room URL forces a strategy, for testing both on one browser.

## Tests

- **Backend** (`backend/tests`, 30 tests):
  - the state machine: barrier, stale drops, stalls, force start, seek storms, rejoin, end of film;
  - pipeline decisions per codec, profile, peak window;
  - a full HTTP + WebSocket flow: login, knock, admit, media auth, barrier, chat, kick, the TURN-less bandwidth endpoint, and tusd hooks.
- **Frontend** (`frontend/src/sync/sync.test.ts`): clock offset, drift policy on both strategies, and the prebuffer maths.
- **End to end** (`e2e/`, Playwright, against the running stack). The host runs in Chromium; the guest runs in Chromium, or WebKit with `GUEST=webkit`. Drift is measured on the machine's wall clock, independent of the app's own clock maths.
  ```bash
  cd e2e && npm ci && npx playwright install chromium webkit
  ADMIN_PASSWORD=localtest123 npx playwright test             # 20 s drift run
  DRIFT_SECONDS=300 npx playwright test -g "holds sync"        # the 5-minute run
  GUEST=webkit npx playwright test
  ```
  Covered:
  - synced start with p95 drift under 80 ms;
  - seek;
  - a held-network guest stall that must pause the host, after which both resume together;
  - a socket drop that must not pause anyone;
  - a burst of keyboard seeks that settles on one barrier;
  - pause on the same frame;
  - chat;
  - the call connecting with video both ways.
- **Debug panel**: press `d` in a room for phase, seq, drift, clock offset and RTT, buffer ahead against need, throughput, player engine, corrections, and call state.
  **Send log** posts a snapshot to `data/client-logs/` on the server, which is useful on an iPad with no Mac to inspect it.

## Real-device checklist

Make the sync film with `tools/make-sync-test-video.sh 10`: a big timecode, a frame counter, and a flash plus beep every second. Upload it and run each item below. Test on an iPad (Safari), an iPhone (Safari tab and Home Screen app), Mac Safari, and desktop Chrome.

- [ ] **Measured drift:** put two devices side by side, film them at 240 fps, and read the timecode or flash offset. The target is under 1 frame (42 ms).
- [ ] **30 minutes of continuous play:** the debug panel shows drift staying under 60 ms and only a handful of corrections.
- [ ] **Join with the call on, before the film starts:** the film's volume and output route stay the same when the mic opens. Repeat joining with the call off and starting it later. Note any volume jump; this is the WebKit 236219 risk.
- [ ] **Speakers vs AirPods:** does the friend hear the film echo through your mic? Check Chrome especially.
- [ ] **Lock the screen or switch apps mid-film, then come back:** the room paused for both. On return the socket and camera recover. Press play.
- [ ] **AirPods out on iPhone:** the room pauses for both.
- [ ] **iPad fullscreen + chat:** open chat and type with the on-screen keyboard. Does fullscreen survive? If not, note it; immersive mode remains.
- [ ] **iPhone Home Screen app:** the overlay, chat, mic and camera all work edge-to-edge. Check the safe areas around the notch and home bar.
- [ ] **Upload a 4 GB file from Safari:** keep the screen on (Wake Lock). Then turn Wi-Fi off and on, or reload, and pick the file again: it resumes.
- [ ] **Throttled link:** use a phone hotspot, or macOS Network Link Conditioner at 3 Mbps. The Join card predicts the buffer wait and the room waits about that long, then plays without stalls.
- [ ] **HEVC film:** plays on Apple devices. On a non-Apple browser without HEVC support, the film fails to load. Re-encode it, or keep H.264 films for mixed rooms.

## Risks and unknowns

1. **iOS audio session.** The film may get quieter or route to the earpiece when the mic opens. Mitigated by setting the session at the Join tap. Verify on your iPad: a WebKit fix or regression could change it.
2. **Echo on Chrome with speakers.** It's a browser limitation. Use headphones.
3. **iPhone fullscreen.** There's no element fullscreen, only immersive mode or the Home Screen app. Typing into chat in iPad fullscreen is untested.
4. **VPS egress cap and the Singapore → India route** are unknown until measured (step 2 above). Indian ISPs vary in how they peer with Singapore.
5. **HEVC/10-bit sources** play on Apple devices but not in every Chrome or Firefox. H.264 is the safe choice for mixed rooms.
6. **Safari micro-pause correction** has not been seen on your devices yet. If it is visible, `?sync=safari` vs `?sync=rate` lets you compare, and the thresholds are in `frontend/src/sync/drift.ts`.
7. **sslip.io** is a third-party DNS service. The bare-IP certificate or a cheap domain is the escape hatch.
8. **2 vCPUs** only matter for server re-encodes, which are rare and slow. Packaging is I/O-bound and capped at 1.5 CPUs.

## Troubleshooting

- **The certificate never arrives**: port 80 must be reachable from the internet (check ufw *and* the GoDaddy firewall), and `SITE_ADDRESS` must resolve to the VPS (`dig +short <name>`).
- **The call connects locally but not between two homes**: TURN isn't reachable. Check the UDP 3478 and 49160–49200 rules, `PUBLIC_IP` in `.env`, and `docker compose logs coturn`.
- **Upload rejected with 401**: the host session expired. Sign in again; the upload resumes.
- **A film fails with "does not play in browsers"**: see Using it, step 1.
- **Uploads fail at a fixed size**: raise `MAX_UPLOAD_BYTES` in `.env`.

## Sources

- Let's Encrypt IP-address certificates (GA Jan 2026): https://letsencrypt.org/2025/07/01/issuing-our-first-ip-address-certificate.html
- Caddy `shortlived` profile: https://caddy.community/t/shortlived-certificates-from-lets-encrypt/33399
- Caddy IP certificate issue: https://github.com/caddyserver/caddy/issues/7399
- iPhone still lacks element fullscreen: https://onbugs.webkit.org/show_bug.cgi?id=265438
- screenfull Safari support notes: https://socket.dev/npm/package/screenfull/overview/^5.1.0
- iOS getUserMedia audio session and volume: https://bugs.webkit.org/show_bug.cgi?id=236219
- iOS ducking workaround report: https://bugs.webkit.org/show_bug.cgi?id=294623
- iOS earpiece routing: https://bugs.webkit.org/show_bug.cgi?id=218012
- Safari playbackRate stall: https://bugs.webkit.org/show_bug.cgi?id=163433
- Safari playbackRate pitch: https://bugs.webkit.org/show_bug.cgi?id=225868
- ManagedMediaSource on iPhone: https://radiantmediaplayer.com/blog/at-last-safari-17.1-now-brings-the-new-managed-media-source-api-to-iphone.html
- hls.js with ManagedMediaSource: https://dev.to/masonwritescode/playing-hls-through-managed-media-source-on-iphone-with-hlsjs-3cn8
- Chrome echo-cancellation scope: https://lists.w3.org/Archives/Public/public-webrtc-logs/2019Apr/0334.html
- Chromium echo-cancellation known issues: https://docs.atmoky.com/known-issues
- Wake Lock in Home Screen apps: https://bugs.webkit.org/show_bug.cgi?id=254545
- tusd hooks: https://tus.github.io/tusd/advanced-topics/hooks/
- tus browser support: https://tus.io/demo
- sslip.io: https://sslip.io
