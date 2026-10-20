// Host home. The screen's question: "Is a film ready, and is anyone waiting to get in?"
import { useEffect, useRef, useState } from "preact/hooks";
import * as tus from "tus-js-client";
import { api, type Movie, type RoomInfo } from "../lib/api";
import { navigate } from "../router";
import { ago, clock, codecLabel, gb, initial, length, mbps, personTint, resolution } from "./format";
import { Copy, More, Upload } from "./icons";
import { Page } from "./Shell";

const ACTIVE = new Set(["downloading", "queued", "processing"]);

function usePoll<T>(path: string, ms: (data: T | null) => number): [T | null, () => void, string] {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState("");
  const timer = useRef<number>();
  const dataRef = useRef<T | null>(null);
  const load = async () => {
    clearTimeout(timer.current);
    try {
      const d = await api.get<T>(path);
      dataRef.current = d;
      setData(d);
      setErr("");
    } catch (e: any) {
      setErr(e.message);
      if (e.status === 401) navigate("/login", true);
    }
    timer.current = window.setTimeout(load, ms(dataRef.current));
  };
  useEffect(() => {
    void load();
    return () => clearTimeout(timer.current);
  }, [path]);
  return [data, load, err];
}

export function Home() {
  const [rooms, reloadRooms, roomsErr] = usePoll<RoomInfo[]>("/api/rooms", () => 3000);
  const [movies, reloadMovies, moviesErr] = usePoll<Movie[]>("/api/movies", (d) => (d?.some((m) => ACTIVE.has(m.status)) ? 2000 : 15000));
  const [disk] = usePoll<{ free: number; total: number }>("/api/disk", () => 60000);
  const [creating, setCreating] = useState(false);

  const ready = (movies ?? []).filter((m) => m.status === "ready");
  const knocking = (rooms ?? []).flatMap((r) => r.knocks.map((k) => ({ ...k, room: r })));
  const busy = (movies ?? []).filter((m) => ACTIVE.has(m.status));

  let finding = <>No films yet. Add one to start.</>;
  if (knocking.length) {
    const k = knocking[0];
    finding = <><strong>{k.name}</strong> is waiting to join {k.room.name}.</>;
  } else if (busy.length) {
    const b = busy[0];
    finding = <><strong>{b.title}</strong> is {statusWords(b).toLowerCase()}.</>;
  } else if (ready.length) {
    const watching = (rooms ?? []).find((r) => r.phase === "playing");
    finding = watching
      ? <><strong>{watching.name}</strong> is playing at {clock(watching.pos)}.</>
      : <>{ready.length} {ready.length === 1 ? "film is" : "films are"} ready to watch.</>;
  }

  return (
    <Page current="home" admin>
      <div class="title-row">
        <div>
          <h1>Movie nights</h1>
          <p class="sub">{finding}</p>
        </div>
        <div class="actions">
          <button class="btn primary" onClick={() => setCreating(true)} disabled={!ready.length}>New room</button>
        </div>
      </div>

      <div class="grid">
        <section class="span-4 stack" aria-labelledby="rooms-h">
          <h2 id="rooms-h" class="sr-only">Rooms</h2>
          {creating && <NewRoom films={ready} onDone={(code) => {
            setCreating(false);
            reloadRooms();
            if (code) navigate(`/r/${code}`);
          }} />}
          {roomsErr && <div class="notice neg">Couldn't load rooms: {roomsErr}</div>}
          {rooms === null && !roomsErr && <div class="panel"><div class="skeleton-room" /></div>}
          {rooms?.length === 0 && !creating && (
            <div class="panel">
              <header><h2>Rooms</h2></header>
              <div class="empty">
                <p>{ready.length ? "Open a room for a ready film, then send the invite link to your friend." : "Rooms open once a film is ready."}</p>
                {ready.length > 0 && <button class="btn quiet" onClick={() => setCreating(true)}>New room</button>}
              </div>
            </div>
          )}
          {rooms?.map((r) => <RoomCard key={r.code} room={r} films={ready} onChange={reloadRooms} />)}
        </section>

        <AddFilm class="span-2" onAdded={reloadMovies} freeBytes={disk?.free} />

        <Library class="span-6" movies={movies} err={moviesErr} onChange={reloadMovies} diskFree={disk?.free} diskTotal={disk?.total} />
      </div>
    </Page>
  );
}

function statusWords(m: Movie): string {
  const pct = `${Math.round((m.progress || 0) * 100)}%`;
  switch (m.status) {
    case "downloading": return `Downloading to the server, ${pct}`;
    case "queued": return "Waiting to be processed";
    case "processing": return `Processing, ${pct}`;
    case "needs_transcode": return "Needs a re-encode";
    case "choose_audio": return "Waiting for an audio track";
    case "failed": return "Failed";
    case "ready": return "Ready";
    default: return m.status;
  }
}

// ---- rooms -----------------------------------------------------------------------------------

function NewRoom({ films, onDone }: { films: Movie[]; onDone: (code?: string) => void }) {
  const [name, setName] = useState("Movie night");
  const [film, setFilm] = useState(films[0]?.id ?? "");
  const [err, setErr] = useState("");
  const submit = async (e: Event) => {
    e.preventDefault();
    try {
      const r = await api.post<RoomInfo>("/api/rooms", { name, movie_id: film || null });
      onDone(r.code);
    } catch (x: any) {
      setErr(x.message);
    }
  };
  return (
    <form class="panel stack" onSubmit={submit}>
      <header><h2>New room</h2><button type="button" class="text-btn muted" onClick={() => onDone()}>Cancel</button></header>
      <div class="grid">
        <div class="field span-3">
          <label for="rn">Name</label>
          <input id="rn" class="input" value={name} maxLength={120} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        </div>
        <div class="field span-3">
          <label for="rf">Film</label>
          <select id="rf" class="input" value={film} onChange={(e) => setFilm((e.target as HTMLSelectElement).value)}>
            {films.map((f) => <option value={f.id}>{f.title}</option>)}
          </select>
        </div>
      </div>
      {err && <span class="form-error">{err}</span>}
      <div><button class="btn primary" type="submit">Open room</button></div>
    </form>
  );
}

function RoomCard({ room, films, onChange }: { room: RoomInfo; films: Movie[]; onChange: () => void }) {
  const [copied, setCopied] = useState(false);
  const [menu, setMenu] = useState(false);
  const link = `${location.origin}/r/${room.code}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      prompt("Copy the invite link", link);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };
  const act = async (gid: string, a: "admit" | "deny" | "kick") => {
    await api.post(`/api/rooms/${room.code}/guests/${gid}/${a}`);
    onChange();
  };
  const people = room.members.filter((m) => m.connected || m.state !== "away");
  const m = room.movie;
  return (
    <article class="panel room">
      {m?.poster ? <img class="poster" src={m.poster} alt="" loading="lazy" /> : <div class="poster" />}
      <div>
        <div style={{ display: "flex", gap: "12px", alignItems: "flex-start" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3>{room.name}</h3>
            <p class="film">{m ? <>{m.title} · {length(m.duration)}</> : "No film chosen"}</p>
          </div>
          <span class={`pill${room.phase === "playing" ? " pos" : ""}`}>
            {room.phase === "playing" ? <>Playing · <span class="num">{clock(room.pos)}</span></> : room.phase === "preparing" ? "Getting ready" : room.members.some((x) => x.connected) ? <>Paused · <span class="num">{clock(room.pos)}</span></> : "Empty"}
          </span>
          <div class="menu-wrap">
            <button class="btn icon quiet sm" aria-label="Room options" onClick={() => setMenu(!menu)}><More size={18} /></button>
            {menu && (
              <div class="menu" onMouseLeave={() => setMenu(false)}>
                {films.filter((f) => f.id !== m?.id).map((f) => (
                  <button onClick={async () => { setMenu(false); await api.patch(`/api/rooms/${room.code}`, { movie_id: f.id }); onChange(); }}>Switch to {f.title}</button>
                ))}
                <button class="neg" onClick={async () => {
                  setMenu(false);
                  if (confirm(`Close "${room.name}"? Its invite link stops working and anyone inside is sent out.`)) {
                    await api.del(`/api/rooms/${room.code}`);
                    onChange();
                  }
                }}>Close room</button>
              </div>
            )}
          </div>
        </div>

        {room.knocks.map((k) => (
          <div class="knock" role="alert">
            <span class="avatar" style={personTint(false)}>{initial(k.name)}</span>
            <div class="grow"><strong>{k.name}</strong> <span class="muted">wants to join · {ago(k.since)}</span></div>
            <button class="text-btn muted" onClick={() => act(k.id, "deny")}>Deny</button>
            <button class="btn sm primary" onClick={() => act(k.id, "admit")}>Let in</button>
          </div>
        ))}

        {people.length > 0 && (
          <div class="people">
            {people.map((p) => (
              <div class="person">
                <span class="avatar" style={personTint(p.admin)}>{initial(p.name)}</span>
                <span style={{ flex: 1 }}>{p.admin ? `${p.name} (you)` : p.name}</span>
                <span class="muted num" style={{ fontSize: "13px" }}>
                  {!p.connected ? "Away" : p.state === "buffering" ? "Buffering" : p.mbps ? `${mbps(p.mbps)} Mbps · ${p.rtt} ms` : "Connected"}
                </span>
                {!p.admin && <button class="text-btn neg" style={{ fontSize: "13px" }} onClick={() => confirm(`Send ${p.name} out of the room?`) && act(p.id, "kick")}>Remove</button>}
              </div>
            ))}
          </div>
        )}

        <div class="foot">
          <button class="btn quiet" onClick={() => navigate(`/r/${room.code}`)} disabled={!m}>Enter room</button>
          <button class="btn" onClick={copy}><Copy size={16} />{copied ? "Copied" : "Copy invite link"}</button>
        </div>
      </div>
    </article>
  );
}

// ---- adding films ----------------------------------------------------------------------------

interface UploadState {
  name: string;
  sent: number;
  total: number;
  mbps: number;
  error?: string;
}

function AddFilm({ class: cls, onAdded, freeBytes }: { class: string; onAdded: () => void; freeBytes?: number }) {
  const [up, setUp] = useState<UploadState | null>(null);
  const [over, setOver] = useState(false);
  const [url, setUrl] = useState("");
  const [urlErr, setUrlErr] = useState("");
  const uploadRef = useRef<tus.Upload | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const wake = useRef<any>(null);

  const keepAwake = async (on: boolean) => {
    try {
      if (on && "wakeLock" in navigator) wake.current = await (navigator as any).wakeLock.request("screen");
      if (!on) {
        await wake.current?.release();
        wake.current = null;
      }
    } catch {
      /* not supported: the hint below asks to keep the screen on */
    }
  };

  const start = (file: File) => {
    if (freeBytes && file.size > freeBytes * 0.45) {
      setUp({ name: file.name, sent: 0, total: file.size, mbps: 0, error: `Not enough free disk on the server for this file (${gb(freeBytes)} free).` });
      return;
    }
    let lastT = performance.now();
    let lastB = 0;
    let rate = 0;
    const upload = new tus.Upload(file, {
      endpoint: "/files/",
      chunkSize: 32 * 1024 * 1024,
      retryDelays: [0, 1000, 3000, 5000, 10000, 20000, 30000],
      removeFingerprintOnSuccess: true,
      metadata: { filename: file.name, filetype: file.type, title: file.name.replace(/\.[^.]+$/, "").replace(/[._]+/g, " ") },
      onProgress: (sent, total) => {
        const now = performance.now();
        if (now - lastT > 1500) {
          const r = ((sent - lastB) * 8) / ((now - lastT) / 1000) / 1e6;
          rate = rate ? rate * 0.6 + r * 0.4 : r;
          lastT = now;
          lastB = sent;
        }
        setUp({ name: file.name, sent, total, mbps: rate });
      },
      onError: (e) => {
        void keepAwake(false);
        setUp((u) => u && { ...u, error: friendlyTusError(e) });
      },
      onSuccess: () => {
        void keepAwake(false);
        setUp(null);
        onAdded();
      },
    });
    uploadRef.current = upload;
    setUp({ name: file.name, sent: 0, total: file.size, mbps: 0 });
    void keepAwake(true);
    // resume an interrupted upload of the same file instead of starting over
    upload.findPreviousUploads().then((prev) => {
      if (prev.length) upload.resumeFromPreviousUpload(prev[0]);
      upload.start();
    });
  };

  const cancel = async () => {
    await uploadRef.current?.abort(true);
    void keepAwake(false);
    setUp(null);
  };

  const importUrl = async (e: Event) => {
    e.preventDefault();
    setUrlErr("");
    try {
      await api.post("/api/movies/import", { url: url.trim(), title: "" });
      setUrl("");
      onAdded();
    } catch (x: any) {
      setUrlErr(x.message);
    }
  };

  const left = up && up.mbps > 0 ? ((up.total - up.sent) * 8) / (up.mbps * 1e6) : 0;

  return (
    <section class={`panel stack ${cls}`} aria-labelledby="add-h">
      <header style={{ marginBottom: 0 }}><h2 id="add-h">Add a film</h2></header>
      {up ? (
        <div class="inner stack" style={{ gap: "10px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: "10px" }}>
            <strong style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{up.name}</strong>
            <span class="num muted">{Math.floor((up.sent / up.total) * 100)}%</span>
          </div>
          <div class="bar"><span style={{ width: `${(up.sent / up.total) * 100}%` }} /></div>
          {up.error ? (
            <>
              <p class="form-error">{up.error}</p>
              <div style={{ display: "flex", gap: "10px" }}>
                <button class="btn sm" onClick={() => uploadRef.current?.start()}>Resume</button>
                <button class="text-btn muted" onClick={cancel}>Cancel</button>
              </div>
            </>
          ) : (
            <>
              <p class="muted num" style={{ fontSize: "13px" }}>
                {gb(up.sent)} of {gb(up.total)}{up.mbps ? ` · ${mbps(up.mbps)} Mbps · about ${length(left)} left` : ""}
              </p>
              <p class="faint" style={{ fontSize: "12px", lineHeight: "16px" }}>Keep this tab open and the screen on. If it drops, choosing the same file again resumes where it stopped.</p>
              <div><button class="text-btn muted" onClick={cancel}>Cancel upload</button></div>
            </>
          )}
        </div>
      ) : (
        <label
          class={`drop${over ? " over" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            const f = e.dataTransfer?.files[0];
            if (f) start(f);
          }}
        >
          <Upload size={22} />
          <span><strong>Choose a video file</strong> or drop it here</span>
          <span class="faint" style={{ fontSize: "12px" }}>MP4, MKV, MOV. Uploads resume if the connection drops.</span>
          <input ref={fileRef} type="file" accept="video/*,.mkv,.mp4,.m4v,.mov,.webm,.ts" class="sr-only"
            onChange={(e) => {
              const f = (e.target as HTMLInputElement).files?.[0];
              if (f) start(f);
              (e.target as HTMLInputElement).value = "";
            }} />
        </label>
      )}
      <form class="field" onSubmit={importUrl}>
        <label for="imp">Or let the server download it</label>
        <div style={{ display: "flex", gap: "8px" }}>
          <input id="imp" class="input" type="url" inputMode="url" placeholder="https://…/film.mkv" value={url}
            onInput={(e) => setUrl((e.target as HTMLInputElement).value)} />
          <button class="btn" type="submit" disabled={!url.trim()}>Import</button>
        </div>
        <span class="hint">A direct link skips your home upload entirely.</span>
        {urlErr && <span class="form-error">{urlErr}</span>}
      </form>
    </section>
  );
}

function trackLabel(a: Movie["audio_tracks"][number]): string {
  const lang = a.lang && a.lang !== "und" ? a.lang.toUpperCase() : "Unknown language";
  return `${a.title || lang} · ${codecLabel(a.codec)} ${a.channels === 6 ? "5.1" : a.channels === 8 ? "7.1" : a.channels === 2 ? "stereo" : `${a.channels} ch`}${a.default ? " · default" : ""}`;
}

function friendlyTusError(e: Error): string {
  const msg = String(e.message || e);
  if (/401/.test(msg)) return "Your host session expired. Sign in again, then resume.";
  if (/413/.test(msg)) return "Not enough free disk on the server for this file.";
  return "The upload stopped. Check the connection and resume.";
}

// ---- library ---------------------------------------------------------------------------------

function Library({ class: cls, movies, err, onChange, diskFree, diskTotal }: {
  class: string; movies: Movie[] | null; err: string; onChange: () => void; diskFree?: number; diskTotal?: number;
}) {
  return (
    <section class={`panel ${cls}`} aria-labelledby="lib-h">
      <header>
        <h2 id="lib-h">Library</h2>
        <span class="meta num">{movies ? `${movies.length} ${movies.length === 1 ? "film" : "films"}` : ""}{diskFree !== undefined && diskTotal ? ` · ${gb(diskFree)} free of ${gb(diskTotal)}` : ""}</span>
      </header>
      {err && <div class="notice neg">Couldn't load films: {err}</div>}
      {movies?.length === 0 && <div class="empty">Uploaded and imported films appear here while they are processed.</div>}
      {movies && movies.length > 0 && (
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Film</th>
                <th class="n hide-sm">Length</th>
                <th class="n hide-sm">Size</th>
                <th class="n hide-sm">Peak Mbps</th>
                <th>Status</th>
                <th><span class="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>{movies.map((m) => <FilmRow key={m.id} m={m} onChange={onChange} />)}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function FilmRow({ m, onChange }: { m: Movie; onChange: () => void }) {
  const [menu, setMenu] = useState(false);
  const tech = [resolution(m.width, m.height), codecLabel(m.video_codec), codecLabel(m.audio_codec)].filter(Boolean).join(" · ");
  const run = async (f: () => Promise<unknown>) => {
    setMenu(false);
    try {
      await f();
    } catch (e: any) {
      alert(e.message);
    }
    onChange();
  };
  return (
    <tr>
      <td>
        <div style={{ display: "flex", gap: "12px", alignItems: "center", minWidth: "220px" }}>
          {m.poster ? <img class="thumb" src={m.poster} alt="" loading="lazy" /> : <div class="thumb" />}
          <div style={{ minWidth: 0 }}>
            <div class="name" style={{ fontWeight: 500 }}>{m.title}</div>
            <span class="line2">{tech || (m.status === "downloading" ? "Downloading" : "Not probed yet")}</span>
          </div>
        </div>
      </td>
      <td class="n hide-sm">{m.duration ? length(m.duration) : <span class="faint">—</span>}</td>
      <td class="n hide-sm">{gb(m.size_bytes)}</td>
      <td class="n hide-sm">{m.peak_mbps ? mbps(m.peak_mbps) : <span class="faint">—</span>}</td>
      <td style={{ minWidth: "180px" }}>
        {(m.status === "processing" || m.status === "downloading") ? (
          <div style={{ display: "grid", gap: "6px" }}>
            <span class="num" style={{ fontSize: "13px" }}>{statusWords(m)}</span>
            <div class="bar"><span style={{ width: `${Math.round(m.progress * 100)}%` }} /></div>
          </div>
        ) : m.status === "ready" ? (
          <span class="pill pos">Ready</span>
        ) : m.status === "failed" ? (
          <><span class="pill neg">Failed</span><span class="line2" title={m.error ?? ""}>{(m.error ?? "").slice(0, 80)}</span></>
        ) : m.status === "choose_audio" ? (
          <div style={{ display: "grid", gap: "6px" }}>
            <span class="pill warn" style={{ justifySelf: "start" }}>Pick the audio</span>
            <select class="input" style={{ height: "32px" }} aria-label={`Audio track for ${m.title}`} value=""
              onChange={(e) => void run(() => api.patch(`/api/movies/${m.id}`, { audio_index: Number((e.target as HTMLSelectElement).value) }))}>
              <option value="" disabled>Choose a track…</option>
              {m.audio_tracks.map((a) => <option value={a.index}>{trackLabel(a)}</option>)}
            </select>
          </div>
        ) : m.status === "needs_transcode" ? (
          <><span class="pill warn">Needs a re-encode</span><span class="line2">{m.note}</span></>
        ) : (
          <span class="pill">{statusWords(m)}</span>
        )}
        {m.status === "ready" && m.note && <span class="line2">{m.note}</span>}
      </td>
      <td class="n">
        <div class="menu-wrap" style={{ display: "inline-block" }}>
          <button class="btn icon quiet sm" aria-label={`Options for ${m.title}`} onClick={() => setMenu(!menu)}><More size={18} /></button>
          {menu && (
            <div class="menu" onMouseLeave={() => setMenu(false)}>
              <button onClick={() => {
                const t = prompt("Film title", m.title);
                if (t) void run(() => api.patch(`/api/movies/${m.id}`, { title: t }));
              }}>Rename</button>
              {m.status === "needs_transcode" && (
                <button onClick={() => {
                  const hours = m.duration ? (m.duration / 3600) * 1.5 : 3;
                  if (confirm(`Re-encode "${m.title}" on the server? On 2 CPU cores this takes roughly ${hours.toFixed(1)} hours. Encoding at home with tools/encode-at-home.sh is faster.`)) {
                    void run(() => api.post(`/api/movies/${m.id}/transcode`));
                  }
                }}>Re-encode on server</button>
              )}
              {m.audio_tracks.length > 1 && (m.status === "failed" || m.status === "needs_transcode") && m.audio_tracks.map((a) => (
                <button onClick={() => {
                  void run(async () => {
                    await api.patch(`/api/movies/${m.id}`, { audio_index: a.index });
                    if (m.status === "failed") await api.post(`/api/movies/${m.id}/retry`);
                  });
                }}>Audio: {trackLabel(a)}</button>
              ))}
              {m.status === "failed" && <button onClick={() => void run(() => api.post(`/api/movies/${m.id}/retry`))}>Try again</button>}
              <button class="neg" onClick={() => {
                if (confirm(`Delete "${m.title}"? Its files are removed from the server.`)) void run(() => api.del(`/api/movies/${m.id}`));
              }}>Delete</button>
            </div>
          )}
        </div>
      </td>
    </tr>
  );
}
