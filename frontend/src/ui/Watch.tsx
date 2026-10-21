// The watch screen. The film is the screen; everything else is an overlay that works in
// fullscreen: transport, the sync lanes, chat, mic and camera, and the two camera tiles.
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Call, type CallView } from "../call/rtc";
import { api, type Knock, type MemberInfo, type RoomSession } from "../lib/api";
import { speedTest } from "../lib/bw";
import { RoomSocket, type Msg } from "../lib/socket";
import { Player } from "../player/player";
import { navigate } from "../router";
import { SyncEngine, type EngineView } from "../sync/engine";
import { prebufferNeeded } from "../sync/prebuffer";
import { clock, fmtDelay, hhmm, initial, length, mbps, personTint } from "./format";
import * as Ic from "./icons";
import { loadStyle, saveStyle, SubtitleLayer, SubtitleSheet, type SubStyle } from "./Subtitles";

interface ChatMsg {
  id: number;
  member: string;
  name: string;
  text: string;
  ts: number;
}

const IDLE_MS = 3000;
const PRELOAD_S = 30;        // buffer goal behind the gate and while the call connects
const CALL_SETUP_MS = 60_000;

/** "Meen (34 of 60 s buffered)", or just the name before their first report. */
function waitingText(m: MemberInfo): string {
  if (!m.need || m.state !== "loading") return m.name;
  return `${m.name} (${Math.min(m.ahead, m.need).toFixed(0)} of ${m.need.toFixed(0)} s buffered)`;
}

/** Where a snapshot says the room is now (rough: the clock is not synced yet; only for preloading). */
function roomPosition(m: Msg): number {
  return m.phase === "playing" ? m.pos + Math.max(0, m.now - m.anchor) / 1000 : m.pos;
}

function fullscreenSupported(): boolean {
  const d = document as any;
  return !!(d.fullscreenEnabled || d.webkitFullscreenEnabled);
}

function isFullscreen(): boolean {
  const d = document as any;
  return !!(d.fullscreenElement || d.webkitFullscreenElement);
}

export function Watch({ code }: { code: string }) {
  const [sess, setSess] = useState<RoomSession | null>(null);
  const [loadErr, setLoadErr] = useState("");

  const load = useCallback(() => {
    api.get<RoomSession>(`/api/rooms/${code}/session`).then(setSess).catch((e) => setLoadErr(e.message));
  }, [code]);
  useEffect(load, [load]);

  if (loadErr) {
    return (
      <main class="solo"><div class="solo-card"><h1>Can't open this room</h1><p class="lead">{loadErr}</p>
        <button class="btn" onClick={() => navigate("/")}>Back</button></div></main>
    );
  }
  if (!sess) return <div class="stage"><div class="center-msg"><span class="spinner" /></div></div>;
  return <Stage key={sess.movie?.id ?? "none"} sess={sess} code={code} reload={load} />;
}

function Stage({ sess, code, reload }: { sess: RoomSession; code: string; reload: () => void }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [joined, setJoined] = useState(false);
  const [, force] = useState(0);
  const rerender = useCallback(() => force((n) => (n + 1) % 1e9), []);

  // long-lived objects
  const socket = useMemo(() => new RoomSocket(code), [code]);
  const call = useMemo(() => new Call(socket, !sess.you.admin), [socket]);
  const playerRef = useRef<Player | null>(null);
  const engineRef = useRef<SyncEngine | null>(null);

  const [members, setMembers] = useState<MemberInfo[]>([]);
  const [knocks, setKnocks] = useState<Knock[]>([]);
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [chatOpen, setChatOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [typing, setTyping] = useState("");
  const [toast, setToast] = useState("");
  const [ended, setEnded] = useState("");
  const [idle, setIdle] = useState(false);
  const [fs, setFs] = useState(false);
  const [hud, setHud] = useState(() => new URLSearchParams(location.search).has("debug"));
  const [subsOpen, setSubsOpen] = useState(false);
  const [filmMuted, setFilmMuted] = useState(false);
  const chatOpenRef = useRef(chatOpen);
  chatOpenRef.current = chatOpen;

  const flash = useCallback((t: string) => {
    setToast(t);
    window.setTimeout(() => setToast((x) => (x === t ? "" : x)), 3200);
  }, []);

  // ---- socket wiring (before join, so presence and chat history are there) ----
  useEffect(() => {
    const offs = [
      socket.on("presence", (m) => setMembers(m.members)),
      socket.on("snapshot", (m) => setMembers(m.members)),
      socket.on("knocks", (m) => setKnocks(m.knocks)),
      socket.on("chat_history", (m) => setChat(m.messages)),
      socket.on("chat", (m: Msg) => {
        setChat((c) => [...c.slice(-199), m as unknown as ChatMsg]);
        if (m.member !== sess.you.id) {
          setTyping("");
          if (!chatOpenRef.current) {
            setUnread((u) => u + 1);
            flash(`${m.name}: ${String(m.text).slice(0, 60)}`);
          }
        }
      }),
      socket.on("typing", () => {
        const peer = members.find((x) => x.id !== sess.you.id);
        setTyping(`${peer?.name ?? "Your friend"} is typing…`);
        window.setTimeout(() => setTyping(""), 3000);
      }),
      socket.on("movie_changed", () => reload()),
      socket.on("kicked", () => setEnded("You were removed from this room.")),
      socket.on("replaced", () => setEnded("This room is open in another tab or device.")),
      socket.on("closed", (m) => setEnded((e) => e || (m.code === 4004 ? "The host closed this room." : "You are no longer in this room."))),
      socket.on("notice", (m) => m.kind === "waiting" && flash(`Still waiting for ${m.names.join(" and ")}…`)),
      socket.onStatus((s) => {
        if (s === "closed") flash("Connection lost. Reconnecting…");
        rerender();
      }),
    ];
    return () => offs.forEach((f) => f());
  }, [socket, members]);

  useEffect(() => () => {
    engineRef.current?.stop();
    call.stop();
    playerRef.current?.destroy();
    socket.close();
  }, []);

  // ---- player (loads behind the gate so the first frames are ready at the tap) ----
  // It preloads where the room is, not at 0:00: a guest joining at 55:45 otherwise downloads
  // minutes of the opening for nothing, on the same link the call is trying to connect over.
  useEffect(() => {
    const v = videoRef.current;
    const manifest = sess.movie?.manifest;
    if (!v || !manifest) return;
    const p = new Player(v);
    playerRef.current = p;
    p.setGoal(PRELOAD_S);
    let loaded = false;
    const go = (m: Msg | null) => {
      if (loaded) return;
      loaded = true;
      try {
        p.load(manifest, m ? roomPosition(m) : 0);
      } catch (e: any) {
        setEnded(e.message);
      }
    };
    if (socket.snapshot) go(socket.snapshot);
    const off = socket.on("snapshot", go);
    const t = window.setTimeout(() => go(null), 3000);
    return () => {
      off();
      clearTimeout(t);
      p.destroy();
    };
  }, [sess.movie?.manifest]);

  // ---- the Join tap: one gesture unlocks autoplay with sound, the iOS audio session and the camera
  const join = async (opts: { camera: boolean; mic: boolean }) => {
    const v = videoRef.current;
    const p = playerRef.current;
    if (v) {
      // a play() inside the gesture blesses the element for later programmatic plays (iOS)
      v.muted = false;
      const pr = v.play();
      v.pause();
      pr?.catch(() => {});
    }
    setJoined(true);
    if (opts.camera || opts.mic) void call.start(opts);
    if (p) {
      const e = new SyncEngine(socket, p, sess.profile, sess.you.id);
      engineRef.current = e;
      e.subscribe(rerender);
      e.start();
      socket.send({ t: "resync" }, true);
    }
    // handles for the e2e suite and for poking at a session from the console
    (window as any).__msync = { engine: engineRef.current, socket, call, player: p };
  };

  useEffect(() => call.subscribe(rerender), [call]);

  // refresh the camera when coming back from the background (iOS stops it)
  useEffect(() => {
    const f = () => document.visibilityState === "visible" && void call.refreshCamera();
    document.addEventListener("visibilitychange", f);
    return () => document.removeEventListener("visibilitychange", f);
  }, [call]);

  // duck the film while the friend talks (desktop; iOS keeps volume under the user's control)
  const cv: CallView = call.view();
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.volume = cv.speaking ? 0.4 : 1;
  }, [cv.speaking]);

  // Hold the film's buffer to a short goal until the call connects (at most a minute): a
  // full-speed fill of minutes of film queues the call's handshake behind it on the link.
  useEffect(() => {
    const p = playerRef.current;
    if (!p) return;
    const settingUp = call.started && cv.state !== "connected" && performance.now() - call.startedAt < CALL_SETUP_MS;
    const need = engineRef.current?.needAhead ?? 0;
    p.setGoal(!joined || settingUp ? Math.max(PRELOAD_S, need + 5) : null);
  });

  // keep the screen awake while watching
  useEffect(() => {
    if (!joined) return;
    let lock: any = null;
    const get = async () => {
      try {
        if (document.visibilityState === "visible" && "wakeLock" in navigator) lock = await (navigator as any).wakeLock.request("screen");
      } catch {
        /* fine */
      }
    };
    void get();
    document.addEventListener("visibilitychange", get);
    return () => {
      document.removeEventListener("visibilitychange", get);
      lock?.release?.();
    };
  }, [joined]);

  // ---- controls auto-hide ----
  const idleTimer = useRef<number>();
  const wake = useCallback(() => {
    setIdle(false);
    clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setIdle(true), IDLE_MS);
  }, []);
  useEffect(() => {
    wake();
    return () => clearTimeout(idleTimer.current);
  }, []);

  // ---- fullscreen: the container, so the overlay stays (iPhone: immersive instead) ----
  useEffect(() => {
    const f = () => setFs(isFullscreen());
    document.addEventListener("fullscreenchange", f);
    document.addEventListener("webkitfullscreenchange", f);
    return () => {
      document.removeEventListener("fullscreenchange", f);
      document.removeEventListener("webkitfullscreenchange", f);
    };
  }, []);
  const toggleFs = async () => {
    const el = stageRef.current as any;
    const d = document as any;
    if (!fullscreenSupported()) {
      const standalone = (navigator as any).standalone || matchMedia("(display-mode: standalone)").matches;
      flash(standalone ? "This is already full screen." : "For full screen on iPhone: Share, then Add to Home Screen.");
      return;
    }
    try {
      if (isFullscreen()) await (d.exitFullscreen?.() ?? d.webkitExitFullscreen?.());
      else await (el.requestFullscreen?.({ navigationUI: "hide" }) ?? el.webkitRequestFullscreen?.());
    } catch {
      flash("Full screen is not available here.");
    }
  };

  // ---- seeking with coalesced keyboard steps ----
  const pendingSeek = useRef<{ to: number; timer?: number } | null>(null);
  const engine = engineRef.current;
  const ev: EngineView | null = engine?.view() ?? null;
  const duration = playerRef.current?.duration || sess.movie?.duration || 0;
  const pos = videoRef.current && joined ? videoRef.current.currentTime : ev?.target ?? 0;

  const stepSeek = (delta: number) => {
    if (!engine) return;
    const base = pendingSeek.current?.to ?? pos;
    const to = Math.max(0, Math.min(duration - 1, base + delta));
    clearTimeout(pendingSeek.current?.timer);
    pendingSeek.current = {
      to,
      timer: window.setTimeout(() => {
        engine.seek(to);
        pendingSeek.current = null;
      }, 400),
    };
    flash(`${delta > 0 ? "Forward" : "Back"} to ${clock(to)}`);
    rerender();
  };

  const playing = ev?.phase === "playing" || (ev?.phase === "preparing" && engine?.wantPlaying);
  const togglePlay = () => {
    if (!engine) return;
    const ok = playing ? engine.pause() : engine.play();
    if (!ok) flash("Reconnecting… try again in a moment.");
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input, textarea")) return;
      wake();
      switch (e.key) {
        case " ": case "k": e.preventDefault(); togglePlay(); break;
        case "ArrowLeft": e.preventDefault(); stepSeek(-10); break;
        case "ArrowRight": e.preventDefault(); stepSeek(10); break;
        case "f": void toggleFs(); break;
        case "c": setChatOpen((o) => !o); setSubsOpen(false); setUnread(0); break;
        case "Escape": setSubsOpen(false); break;
        case "m": call.toggleMic(); break;
        case "v": call.toggleCam(); break;
        case "d": setHud((h) => !h); break;
        // VLC's keys: G earlier, H later, 50 ms a press
        case "g": if (subFile) changeDelay(subDelay - 0.05, true); break;
        case "h": if (subFile) changeDelay(subDelay + 0.05, true); break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ---- subtitles ----
  const movieId = sess.movie?.id;
  const [subs, setSubs] = useState(sess.movie?.subtitles ?? []);
  const fileKey = `msync:subfile:${movieId}`;
  const [subFile, setSubFile] = useState<string | null>(() => {
    const f = store.get(fileKey);
    return f && subs.some((s) => s.file === f) ? f : null;
  });
  useEffect(() => socket.on("subtitles", (m) => {
    if (m.movie !== movieId) return;
    setSubs(m.subtitles);
    setSubFile((f) => (f && m.subtitles.some((s: { file: string }) => s.file === f) ? f : null));
  }), [socket]);
  const pickSub = (f: string | null) => {
    setSubFile(f);
    if (f) store.set(fileKey, f);
    else store.del(fileKey);
  };
  // the <track>s only load cues; SubtitleLayer draws them
  useEffect(() => {
    videoRef.current?.querySelectorAll<HTMLTrackElement>("track").forEach((el) => {
      el.track.mode = el.dataset.file === subFile ? "hidden" : "disabled";
    });
  }, [subFile, subs, joined]);

  // timing: the host's shared delay, unless this device has its own (VLC style).
  // A personal value remembers the shared value it was based on; once the host saves a new
  // shared value, everyone follows that again.
  const shared = subs.find((s) => s.file === subFile)?.delay ?? 0;
  const delayKey = `msync:subdelay:${movieId}:${subFile}`;
  const [mine, setMine] = useState<number | null>(null);
  useEffect(() => {
    let v: number | null = null;
    try {
      const o = JSON.parse(store.get(delayKey) || "null");
      if (o && o.base === shared && Number.isFinite(o.d)) v = o.d;
    } catch {
      /* old or broken value */
    }
    setMine(v);
  }, [subFile, shared]);
  const subDelay = mine ?? shared;

  const changeDelay = (next: number, announce = false) => {
    if (!subFile) return;
    const d = Math.round(next * 1000) / 1000;
    if (Math.abs(d - shared) < 0.0005) {
      setMine(null);
      store.del(delayKey);
    } else {
      setMine(d);
      store.set(delayKey, JSON.stringify({ d, base: shared }));
    }
    if (announce) flash(`Subtitle delay ${fmtDelay(d)}`);
  };

  const [savingSub, setSavingSub] = useState(false);
  const saveDelayForBoth = async () => {
    if (!subFile || !movieId) return;
    setSavingSub(true);
    try {
      await api.patch(`/api/movies/${movieId}/subtitles/${subFile}`, { delay: subDelay });
      store.del(delayKey);
      flash(`Subtitle timing ${fmtDelay(subDelay)} saved for both of you`);
    } catch (e: any) {
      flash(e.message);
    } finally {
      setSavingSub(false);
    }
  };

  const [subStyle, setSubStyle] = useState<SubStyle>(loadStyle);
  // a sample line for a moment after a style change, when no real line is on screen
  const [subSample, setSubSample] = useState(false);
  const sampleTimer = useRef<number>();
  const changeStyle = (st: SubStyle) => {
    setSubStyle(st);
    saveStyle(st);
    setSubSample(true);
    clearTimeout(sampleTimer.current);
    sampleTimer.current = window.setTimeout(() => setSubSample(false), 2500);
  };
  useEffect(() => () => clearTimeout(sampleTimer.current), []);

  // the subtitles and the settings sheet sit above the controls while those are showing
  const barRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const bar = barRef.current;
    const stage = stageRef.current;
    if (!bar || !stage || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => stage.style.setProperty("--bar-h", `${bar.offsetHeight}px`));
    ro.observe(bar);
    return () => ro.disconnect();
  }, [joined, !!sess.movie]);

  const peer = members.find((m) => m.id !== sess.you.id);
  const me = members.find((m) => m.id === sess.you.id);
  const movie = sess.movie;

  // what the centre of the screen says
  let center: preact.JSX.Element | null = null;
  if (ended) {
    center = <div class="center-msg"><strong>{ended}</strong>{sess.you.admin && <button class="btn" onClick={() => navigate("/")}>Back to movie nights</button>}</div>;
  } else if (!movie) {
    center = <div class="center-msg"><strong>No film yet</strong><p>{sess.you.admin ? "Pick a film for this room from Movie nights." : "Your host is choosing the film."}</p></div>;
  } else if (joined && ev) {
    if (ev.blocked === "tap") {
      center = <div class="center-msg"><strong>Tap to start watching</strong><button class="btn primary" onClick={() => void engine!.unblock()}>Watch</button></div>;
    } else if (ev.phase === "preparing") {
      const who = reasonName(ev.reason);
      const buffering = ev.reason.startsWith("buffering:");
      const others = members.filter((m) => m.connected && m.id !== sess.you.id && m.state !== "ready");
      center = (
        <div class="center-msg" role="status">
          <span class="spinner" />
          <strong>{buffering ? `Paused while ${who === me?.name ? "you" : who} catch${who === me?.name ? "" : "es"} up` : "Getting both of you ready"}</strong>
          <p class="num">
            {ev.localState === "ready" ? (others.length ? `Waiting for ${others.map(waitingText).join(" and ")}` : "Starting…")
              : `Buffering ${Math.min(ev.ahead, ev.needAhead).toFixed(0)} of ${ev.needAhead.toFixed(0)} s`}
          </p>
          {sess.you.admin && ev.waitingFor.length > 0 && <button class="btn sm" onClick={() => engine!.forceStart()}>Start without waiting</button>}
        </div>
      );
    }
  }

  const showControls = !idle || !joined || ev?.phase !== "playing" || chatOpen || subsOpen;

  return (
    <div ref={stageRef} class={`stage${showControls ? "" : " idle"}${chatOpen ? " chat-open" : ""}${subsOpen ? " subs-open" : ""}${fullscreenSupported() ? "" : " immersive"}`}
      onPointerMove={wake} onPointerDown={wake}>
      <video ref={videoRef} class="film" playsInline poster={movie?.poster ?? undefined}
        muted={filmMuted}>
        {subs.map((s) => <track key={s.file} data-file={s.file} kind="subtitles" src={`/media/${movie!.id}/${s.file}`} srcLang={s.lang} label={s.label} />)}
      </video>

      {joined && <SubtitleLayer videoRef={videoRef} file={subFile} delay={subDelay} style={subStyle} preview={subSample && subsOpen} />}

      <div class="hit" onClick={() => {
        if (subsOpen) return setSubsOpen(false);
        if (matchMedia("(pointer: coarse)").matches) {
          setIdle((i) => !i);
          if (idle) wake();
        } else if (joined) togglePlay();
      }} onDblClick={() => void toggleFs()} />

      {/* top bar */}
      <div class="bar-top">
        {sess.you.admin && !fs && <button class="cbtn" aria-label="Back to movie nights" onClick={() => navigate("/")}><Ic.ArrowLeft /></button>}
        <div class="title">
          <strong>{movie?.title ?? sess.room.name}</strong>
          <span>{sess.room.name}{movie ? ` · ${length(movie.duration)}` : ""}</span>
        </div>
        <People members={members} you={sess.you.id} />
      </div>

      {center}

      {/* host: a knock while watching */}
      {sess.you.admin && knocks.length > 0 && (
        <div class="toast" style={{ display: "flex", gap: "12px", alignItems: "center" }} role="alert">
          <span><strong>{knocks[0].name}</strong> wants to join</span>
          <button class="text-btn" style={{ color: "#555" }} onClick={() => api.post(`/api/rooms/${code}/guests/${knocks[0].id}/deny`)}>Deny</button>
          <button class="btn sm" style={{ background: "#000", color: "#fff", borderColor: "#000" }} onClick={() => api.post(`/api/rooms/${code}/guests/${knocks[0].id}/admit`)}>Let in</button>
        </div>
      )}
      {toast && !(sess.you.admin && knocks.length) && <div class="toast" role="status">{toast}</div>}

      {/* camera tiles */}
      {joined && call.started && <Tiles call={cv} youName={sess.you.name} peerName={peer?.name ?? "your friend"} you={sess.you.admin} />}

      {/* bottom bar */}
      {joined && movie && (
        <div ref={barRef} class="bar-bottom">
          <Scrub duration={duration} pos={pendingSeek.current?.to ?? pos} buffered={playerRef.current?.bufferedRanges() ?? []}
            onSeek={(t) => engine?.seek(t)} />
          {duration > 0 && members.filter((m) => m.connected).length > 1 && (
            <div class="lanes hide-sm" aria-label="Where each of you is">
              {members.filter((m) => m.connected).map((m) => (
                <Lane m={m} duration={duration} self={m.id === sess.you.id}
                  pos={m.id === sess.you.id ? pos : m.pos} ahead={m.id === sess.you.id ? playerRef.current?.ahead() ?? 0 : m.ahead}
                  drift={m.id === sess.you.id ? ev?.drift ?? 0 : m.drift} />
              ))}
            </div>
          )}
          <div class="controls">
            <button class="cbtn lead" aria-label={playing ? "Pause for both" : "Play for both"} onClick={togglePlay}>
              {playing ? <Ic.Pause size={22} /> : <Ic.Play size={22} />}
            </button>
            <button class="cbtn skip" aria-label="Back 10 seconds" onClick={() => stepSeek(-10)}><Ic.Back10 /></button>
            <button class="cbtn skip" aria-label="Forward 10 seconds" onClick={() => stepSeek(10)}><Ic.Fwd10 /></button>
            <span class="time"><strong>{clock(pos)}</strong> / {clock(duration)}</span>
            <span class="grow" />
            <button class={`cbtn${subFile ? " on" : ""}`} aria-label="Subtitle settings" aria-expanded={subsOpen}
              title={subFile ? subs.find((x) => x.file === subFile)?.label : "Subtitles off"}
              onClick={() => { setSubsOpen(!subsOpen); setChatOpen(false); }}><Ic.Captions /></button>
            <button class="cbtn" aria-label={filmMuted ? "Unmute the film" : "Mute the film"} onClick={() => setFilmMuted(!filmMuted)}>
              {filmMuted ? <Ic.VolumeOff /> : <Ic.Volume />}
            </button>
            {call.started && (
              <>
                <button class={`cbtn${cv.micOn ? "" : " off"}`} aria-label={cv.micOn ? "Mute your microphone" : "Unmute your microphone"} onClick={() => call.toggleMic()}>
                  {cv.micOn ? <Ic.Mic /> : <Ic.MicOff />}
                </button>
                <button class={`cbtn${cv.camOn ? "" : " off"}`} aria-label={cv.camOn ? "Turn your camera off" : "Turn your camera on"} onClick={() => call.toggleCam()}>
                  {cv.camOn ? <Ic.Cam /> : <Ic.CamOff />}
                </button>
              </>
            )}
            {!call.started && (
              <button class="cbtn" aria-label="Start the call" onClick={() => void call.start({ camera: true, mic: true })}><Ic.Cam /></button>
            )}
            <button class="cbtn" aria-label={chatOpen ? "Close chat" : "Open chat"} onClick={() => { setChatOpen(!chatOpen); setSubsOpen(false); setUnread(0); }}>
              <Ic.Chat />{unread > 0 && !chatOpen && <span class="badge">{unread}</span>}
            </button>
            <button class="cbtn" aria-label={fs ? "Exit full screen" : "Full screen"} onClick={() => void toggleFs()}>
              {fs ? <Ic.Shrink /> : <Ic.Expand />}
            </button>
          </div>
        </div>
      )}

      {subsOpen && joined && (
        <SubtitleSheet subs={subs} file={subFile} onPick={pickSub} delay={subDelay} shared={shared}
          onDelay={(d) => changeDelay(d)} onSaveShared={() => void saveDelayForBoth()} saving={savingSub}
          admin={sess.you.admin} style={subStyle} onStyle={changeStyle} onClose={() => setSubsOpen(false)} />
      )}

      {chatOpen && <ChatPanel chat={chat} you={sess.you.id} typing={typing} onClose={() => setChatOpen(false)}
        send={(text) => socket.send({ t: "chat", text, nonce: Math.random().toString(36).slice(2) })}
        onTyping={() => socket.send({ t: "typing" })} />}

      {hud && ev && <Hud ev={ev} player={playerRef.current} call={cv} socket={socket.status} />}

      {!joined && !ended && <Gate sess={sess} onJoin={join} />}
    </div>
  );
}

// localStorage that never throws (private mode, blocked storage)
const store = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string): void {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* fine */
    }
  },
  del(k: string): void {
    try {
      localStorage.removeItem(k);
    } catch {
      /* fine */
    }
  },
};

function reasonName(reason: string): string {
  const i = reason.indexOf(":");
  return i >= 0 ? reason.slice(i + 1) : "";
}

// ---- pieces ----------------------------------------------------------------------------------

function People({ members, you }: { members: MemberInfo[]; you: string }) {
  return (
    <div style={{ display: "flex", gap: "6px" }} aria-label="People in the room">
      {members.map((m) => (
        <span class="avatar" title={`${m.name}${m.id === you ? " (you)" : ""}${m.connected ? "" : " · away"}`}
          style={{ ...personTint(m.admin), opacity: m.connected ? 1 : 0.4 }}>{initial(m.name)}</span>
      ))}
    </div>
  );
}

function Lane({ m, duration, pos, ahead, drift, self }: { m: MemberInfo; duration: number; pos: number; ahead: number; drift: number; self: boolean }) {
  const pct = (x: number) => `${Math.max(0, Math.min(100, (x / duration) * 100))}%`;
  const state = m.state === "buffering" ? "buffering" : Math.abs(drift) < 1000 ? `${drift >= 0 ? "+" : "−"}${Math.abs(Math.round(drift))} ms` : `${(drift / 1000).toFixed(1)} s`;
  return (
    <div class="lane">
      <span class="who">{self ? "You" : m.name}</span>
      <span class="track">
        <span class="buf" style={{ left: pct(pos), width: pct(ahead) }} />
        <span class="head" style={{ left: pct(pos) }} />
      </span>
      <span class="val">{state}</span>
    </div>
  );
}

function Scrub({ duration, pos, buffered, onSeek }: { duration: number; pos: number; buffered: [number, number][]; onSeek: (t: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const at = (e: PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * duration;
  };
  const shown = drag ?? pos;
  const pct = (x: number) => `${duration ? Math.max(0, Math.min(100, (x / duration) * 100)) : 0}%`;
  return (
    <div ref={ref} class={`scrub${drag !== null ? " drag" : ""}`} role="slider" aria-label="Position in the film"
      aria-valuemin={0} aria-valuemax={Math.round(duration)} aria-valuenow={Math.round(shown)} aria-valuetext={clock(shown)} tabIndex={0}
      onPointerDown={(e) => {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        setDrag(at(e));
      }}
      onPointerMove={(e) => {
        if (drag !== null) setDrag(at(e));
        else if (e.pointerType === "mouse") setHover(at(e));
      }}
      onPointerLeave={() => setHover(null)}
      onPointerUp={(e) => {
        if (drag !== null) onSeek(at(e)); // seek on release only, never while scrubbing
        setDrag(null);
      }}
      onPointerCancel={() => setDrag(null)}>
      <div class="rail">
        {buffered.map(([s, e]) => <span class="buffered" style={{ left: pct(s), width: `${duration ? ((e - s) / duration) * 100 : 0}%` }} />)}
        <span class="played" style={{ width: pct(shown) }} />
      </div>
      <span class="knob" style={{ left: pct(shown) }} />
      {(drag ?? hover) !== null && <span class="tip num" style={{ left: pct((drag ?? hover)!) }}>{clock((drag ?? hover)!)}</span>}
    </div>
  );
}

function Tiles({ call, youName, peerName, you }: { call: CallView; youName: string; peerName: string; you: boolean }) {
  const remoteRef = useRef<HTMLVideoElement>(null);
  const localRef = useRef<HTMLVideoElement>(null);
  const [off, setOff] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  useEffect(() => {
    if (remoteRef.current && remoteRef.current.srcObject !== call.remote) remoteRef.current.srcObject = call.remote;
  }, [call.remote]);
  useEffect(() => {
    if (localRef.current && localRef.current.srcObject !== call.local) localRef.current.srcObject = call.local;
  }, [call.local]);
  return (
    <div class="tiles" style={{ transform: `translate(${off.x}px, ${off.y}px)` }}
      onPointerDown={(e) => {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        dragRef.current = { x: e.clientX, y: e.clientY, ox: off.x, oy: off.y };
      }}
      onPointerMove={(e) => {
        const d = dragRef.current;
        if (d) setOff({ x: d.ox + e.clientX - d.x, y: d.oy + e.clientY - d.y });
      }}
      onPointerUp={() => (dragRef.current = null)}>
      <div class={`tile${call.speaking ? " talking" : ""}`}>
        <video ref={remoteRef} autoPlay playsInline />
        {(!call.remote || !call.peerCam) && (
          <div class="off-face"><span class="avatar" style={{ ...personTint(!you), width: "44px", height: "44px", fontSize: "18px" }}>{initial(peerName)}</span></div>
        )}
        <span class="who">{!call.peerMic && <Ic.MicOff size={13} />}{call.remote ? peerName : call.state === "connecting" ? "Connecting…" : `Waiting for ${peerName}`}</span>
      </div>
      {call.local && (
        <div class="tile self">
          <video ref={localRef} autoPlay playsInline muted />
          {!call.camOn && <div class="off-face"><span class="avatar" style={personTint(you)}>{initial(youName)}</span></div>}
          <span class="who">{!call.micOn && <Ic.MicOff size={13} />}You</span>
        </div>
      )}
    </div>
  );
}

function ChatPanel({ chat, you, typing, onClose, send, onTyping }: {
  chat: ChatMsg[]; you: string; typing: string; onClose: () => void; send: (t: string) => boolean; onTyping: () => void;
}) {
  const [text, setText] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  const lastTyping = useRef(0);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [chat.length]);
  return (
    <aside class="chat" aria-label="Chat" onPointerDown={(e) => e.stopPropagation()}>
      <header><h2>Chat</h2><button class="cbtn" aria-label="Close chat" onClick={onClose}><Ic.Close /></button></header>
      <div class="log" ref={logRef} aria-live="polite">
        {chat.length === 0 && <p class="faint">Messages stay with this room.</p>}
        {chat.map((m) => (
          <div class={`msg${m.member === you ? " mine" : ""}`}>
            <div class="meta"><strong>{m.member === you ? "You" : m.name}</strong>{hhmm(m.ts)}</div>
            <div class="body">{m.text}</div>
          </div>
        ))}
      </div>
      <div>
        <div class="typing">{typing}</div>
        <form onSubmit={(e) => {
          e.preventDefault();
          const t = text.trim();
          if (t && send(t)) setText("");
        }}>
          <input class="input" placeholder="Say something" value={text} maxLength={1000} enterKeyHint="send"
            onInput={(e) => {
              setText((e.target as HTMLInputElement).value);
              const now = Date.now();
              if (now - lastTyping.current > 2000) {
                lastTyping.current = now;
                onTyping();
              }
            }} />
          <button class="btn icon primary" type="submit" aria-label="Send" disabled={!text.trim()}><Ic.Send size={18} /></button>
        </form>
      </div>
    </aside>
  );
}

function Hud({ ev, player, call, socket }: { ev: EngineView; player: Player | null; call: CallView; socket: string }) {
  const [sent, setSent] = useState("");
  const rows: [string, string][] = [
    ["phase", `${ev.phase} · seq ${ev.seq}`],
    ["local", ev.localState],
    ["drift", `${Math.round(ev.drift)} ms`],
    ["clock", `offset ${ev.offset.toFixed(1)} · rtt ${ev.rtt.toFixed(0)} ms`],
    ["buffer", `${ev.ahead.toFixed(1)} s ahead · need ${ev.needAhead.toFixed(0)} s`],
    ["network", `${mbps(ev.mbps)} Mbps · ${player?.engine ?? "?"}`],
    ["sync", `${ev.strategy} · ${ev.corrections} fixes${ev.lastCorrection ? ` · ${ev.lastCorrection}` : ""}`],
    ["call", call.state],
    ["socket", socket],
  ];
  return (
    <dl class="hud">
      {rows.map(([k, v]) => <><dt>{k}</dt><dd>{v}</dd></>)}
      <dt />
      <dd style={{ pointerEvents: "auto" }}>
        <button class="text-btn" onClick={async () => {
          await fetch("/api/debug", { method: "POST", body: JSON.stringify({ at: new Date().toISOString(), ua: navigator.userAgent, ev, call: call.state }) });
          setSent("sent");
        }}>{sent || "Send log"}</button>
      </dd>
    </dl>
  );
}

// ---- the gate --------------------------------------------------------------------------------

function Gate({ sess, onJoin }: { sess: RoomSession; onJoin: (o: { camera: boolean; mic: boolean }) => void }) {
  const [down, setDown] = useState<number | null>(null);
  const [cam, setCam] = useState(true);
  const [mic, setMic] = useState(true);
  useEffect(() => {
    speedTest().then((r) => setDown(r.downMbps)).catch(() => setDown(-1));
  }, []);
  const m = sess.movie;
  const prof = sess.profile;
  const wait = down && down > 0 && prof ? prebufferNeeded(prof.segments, down).waitSec : null;
  const verdict = wait === null ? "Checking your connection…"
    : wait < 8 ? "Your connection keeps up with this film. It starts right away."
    : `Your connection is slower than this film's peak, so it buffers about ${length(Math.max(60, wait))} before it starts. It never drops quality.`;
  return (
    <div class="gate">
      <div class="solo-card">
        <div>
          <h1>{m ? m.title : sess.room.name}</h1>
          <p class="lead">{m ? <>{length(m.duration)} · {sess.room.name}</> : "No film chosen yet."}</p>
        </div>
        {m && (
          <dl class="kv">
            <dt>Your connection</dt>
            <dd class="num">{down === null ? <span class="faint">testing…</span> : down < 0 ? "—" : <>{mbps(down)}<small>Mbps</small></>}</dd>
            <dt>The film's peak</dt>
            <dd class="num">{m.peak_mbps ? <>{mbps(m.peak_mbps)}<small>Mbps</small></> : "—"}</dd>
          </dl>
        )}
        {m && <p class="muted">{verdict}</p>}
        <div class="stack" style={{ gap: "10px" }}>
          <label class="row" style={{ minHeight: "auto", padding: 0, gap: "10px" }}>
            <input type="checkbox" checked={cam} onChange={(e) => setCam((e.target as HTMLInputElement).checked)} />
            Join the call with my camera
          </label>
          <label class="row" style={{ minHeight: "auto", padding: 0, gap: "10px", borderTop: 0 }}>
            <input type="checkbox" checked={mic} onChange={(e) => setMic((e.target as HTMLInputElement).checked)} />
            and my microphone
          </label>
          <p class="faint" style={{ fontSize: "12px", lineHeight: "16px" }}>Headphones stop the film's sound from echoing into the call.</p>
        </div>
        <button class="btn primary" onClick={() => onJoin({ camera: cam, mic })}>Join</button>
      </div>
    </div>
  );
}
