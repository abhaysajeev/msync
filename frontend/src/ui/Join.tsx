// The friend's door. The screen's question: "Can I get in?"
import { useEffect, useState } from "preact/hooks";
import { api } from "../lib/api";
import { speedTest, type SpeedResult } from "../lib/bw";
import { length, mbps } from "./format";
import { Mark } from "./icons";

interface PublicRoom {
  code: string;
  name: string;
  movie_title: string | null;
  duration: number | null;
}

type Status = "none" | "knocking" | "admitted" | "denied" | "kicked";

export function Join({ code, onAdmitted }: { code: string; onAdmitted: () => void }) {
  const [room, setRoom] = useState<PublicRoom | null>(null);
  const [err, setErr] = useState("");
  const [status, setStatus] = useState<Status | null>(null);
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem("msync:name") ?? "";
    } catch {
      return "";
    }
  });
  const [busy, setBusy] = useState(false);
  const [speed, setSpeed] = useState<SpeedResult | null>(null);

  useEffect(() => {
    api.get<PublicRoom>(`/api/rooms/${code}/public`).then(setRoom).catch((e) => setErr(e.message));
    api.get<{ status: Status }>(`/api/rooms/${code}/knock`).then((r) => setStatus(r.status ?? "none")).catch(() => setStatus("none"));
  }, [code]);

  // while knocking, check the door every 1.5 s
  useEffect(() => {
    if (status !== "knocking") return;
    const t = setInterval(async () => {
      const r = await api.get<{ status: Status }>(`/api/rooms/${code}/knock`).catch(() => null);
      if (r && r.status !== "knocking") setStatus(r.status);
    }, 1500);
    return () => clearInterval(t);
  }, [status, code]);

  useEffect(() => {
    if (status === "admitted") onAdmitted();
    // test the connection while waiting, so the room can plan its buffer
    if (status === "knocking" && !speed) speedTest().then(setSpeed).catch(() => {});
  }, [status]);

  const knock = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      try {
        localStorage.setItem("msync:name", name.trim());
      } catch {
        /* private mode */
      }
      const r = await api.post<{ status: Status }>(`/api/rooms/${code}/knock`, { name: name.trim() });
      setStatus(r.status);
    } catch (x: any) {
      setErr(x.message);
    } finally {
      setBusy(false);
    }
  };

  if (err && !room) {
    return (
      <main class="solo">
        <div class="solo-card">
          <Mark size={30} />
          <div>
            <h1>This link does not open a room</h1>
            <p class="lead">{err} Ask your host for a fresh invite link.</p>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main class="solo">
      <div class="solo-card">
        <div>
          <Mark size={30} />
          <h1 style={{ marginTop: "18px" }}>{room ? room.name : "Opening the room…"}</h1>
          {room && (
            <p class="lead">
              {room.movie_title ? <>Tonight: <strong>{room.movie_title}</strong>{room.duration ? `, ${length(room.duration)}` : ""}. </> : null}
              Both of you watch the same full-quality file, kept in sync to the frame.
            </p>
          )}
        </div>

        {(status === "none" || status === null) && (
          <form class="stack" onSubmit={knock}>
            <div class="field">
              <label for="nm">Your name</label>
              <input id="nm" class="input" maxLength={40} autoComplete="nickname" value={name}
                onInput={(e) => setName((e.target as HTMLInputElement).value)} autoFocus />
              <span class="hint">Your host sees this and lets you in.</span>
            </div>
            {err && <span class="form-error">{err}</span>}
            <button class="btn primary" type="submit" disabled={busy || !name.trim()}>{busy ? "Knocking…" : "Ask to join"}</button>
          </form>
        )}

        {status === "knocking" && (
          <div class="stack">
            <div class="inner" style={{ display: "flex", gap: "12px", alignItems: "center" }} role="status">
              <span class="spinner" />
              <span>Waiting for your host to let you in.</span>
            </div>
            <dl class="kv">
              <dt>Your connection</dt>
              <dd class="num">{speed ? <>{mbps(speed.downMbps)}<small>Mbps down</small></> : <span class="faint">testing…</span>}</dd>
              <dt>Delay to the server</dt>
              <dd class="num">{speed ? <>{Math.round(speed.latencyMs)}<small>ms</small></> : <span class="faint">—</span>}</dd>
            </dl>
            <p class="faint" style={{ fontSize: "12px", lineHeight: "16px" }}>Headphones keep the film's sound out of your microphone during the call.</p>
          </div>
        )}

        {status === "denied" && (
          <div class="notice neg">Your host did not let you in this time. You can ask again.
            <div style={{ marginTop: "10px" }}><button class="btn sm" onClick={() => setStatus("none")}>Ask again</button></div>
          </div>
        )}
        {status === "kicked" && <div class="notice neg">You were removed from this room.</div>}
      </div>
    </main>
  );
}
