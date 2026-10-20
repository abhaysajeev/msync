// "Is my connection fast enough for this film?"
import { useEffect, useState } from "preact/hooks";
import { api, type Movie } from "../lib/api";
import { speedTest, type SpeedResult } from "../lib/bw";
import { prebufferNeeded } from "../sync/prebuffer";
import { length, mbps } from "./format";
import { Page } from "./Shell";

export function Speed({ admin }: { admin: boolean }) {
  const [step, setStep] = useState("");
  const [res, setRes] = useState<Partial<SpeedResult>>({});
  const [err, setErr] = useState("");
  const [films, setFilms] = useState<Movie[]>([]);

  const run = async () => {
    setErr("");
    setRes({});
    try {
      await speedTest((s, partial) => {
        setStep(s);
        setRes({ ...partial });
      });
    } catch (e: any) {
      setErr(e.message);
      setStep("");
    }
  };

  useEffect(() => {
    void run();
    if (admin) api.get<Movie[]>("/api/movies").then((m) => setFilms(m.filter((x) => x.status === "ready"))).catch(() => {});
  }, []);

  const done = step === "done";
  const down = res.downMbps ?? 0;

  return (
    <Page current="speed" admin={admin}>
      <div class="title-row">
        <div>
          <h1>Speed test</h1>
          <p class="sub">{done ? <>Measured between this device and the server: <strong>{mbps(down)} Mbps</strong> down.</> : "Measuring between this device and the server…"}</p>
        </div>
        <div class="actions"><button class="btn" onClick={run} disabled={!!step && !done && !err}>Test again</button></div>
      </div>

      <div class="grid">
        <section class="panel span-4" aria-label="Results">
          {err && <div class="notice neg">{err}</div>}
          <div class="figures">
            <Fig label="Download" value={res.downMbps} unit="Mbps" pending={step === "download" || step === "latency"} />
            <Fig label="Upload" value={res.upMbps} unit="Mbps" pending={step !== "done" && !!step} />
            <Fig label="Delay" value={res.latencyMs} unit="ms" pending={step === "latency"} digits={0} />
          </div>
          <p class="muted" style={{ marginTop: "16px", lineHeight: "20px" }}>
            Films play at their full bitrate and never drop quality. When the connection is slower than the film's peak,
            the room simply buffers longer before it starts. The call needs about 0.6 Mbps each way.
          </p>
        </section>

        <section class="panel span-2" aria-labelledby="fit-h">
          <header><h2 id="fit-h">What this means</h2></header>
          {!done ? (
            <p class="muted">Results appear when the test finishes.</p>
          ) : films.length ? (
            <div class="rows">
              {films.slice(0, 5).map((f) => <FilmFit film={f} mbps={down} />)}
            </div>
          ) : (
            <dl class="kv">
              <dt>1080p film (about 8 Mbps)</dt><dd>{down >= 10 ? "Starts right away" : `${Math.max(0, Math.round(estimateWait(8, down)))} s buffer`}</dd>
              <dt>4K film (about 25 Mbps)</dt><dd>{down >= 30 ? "Starts right away" : `${length(estimateWait(25, down))} buffer`}</dd>
              <dt>Video call</dt><dd>{(res.upMbps ?? 0) >= 1 ? "Fine" : "May freeze"}</dd>
            </dl>
          )}
        </section>
      </div>
    </Page>
  );
}

function Fig({ label, value, unit, pending, digits = 1 }: { label: string; value?: number; unit: string; pending: boolean; digits?: number }) {
  return (
    <div class="figure">
      <div class="label">{label}</div>
      <div class="value">{value !== undefined ? <>{value.toFixed(digits)}<small>{unit}</small></> : pending ? <span class="faint">…</span> : <span class="faint">—</span>}</div>
    </div>
  );
}

/** Wait for a 2-hour film of constant bitrate. */
function estimateWait(filmMbps: number, down: number): number {
  if (down <= 0) return Infinity;
  const segs: [number, number][] = Array.from({ length: 1200 }, () => [6, (filmMbps * 1e6 * 6) / 8]);
  return prebufferNeeded(segs, down).waitSec;
}

function FilmFit({ film, mbps: down }: { film: Movie; mbps: number }) {
  const peak = film.peak_mbps ?? 0;
  const avg = film.avg_mbps ?? peak;
  const wait = down > 0 && film.duration ? estimateFilmWait(avg, peak, film.duration, down) : Infinity;
  const ok = down >= peak * 1.2;
  return (
    <div class="row">
      <div class="grow">
        <div class="name">{film.title}</div>
        <div class="line2 num">peak {mbps(peak)} Mbps · average {mbps(avg)} Mbps</div>
      </div>
      <span class={`pill ${ok ? "pos" : wait < 60 ? "" : "warn"}`}>
        {ok ? "Starts right away" : Number.isFinite(wait) ? `${length(Math.max(wait, 60)).replace(" 00 m", " h")} buffer` : "Too slow"}
      </span>
    </div>
  );
}

function estimateFilmWait(avg: number, peak: number, duration: number, down: number): number {
  // without the profile here, model the film as average bitrate with a 30 s peak early on
  const n = Math.ceil(duration / 6);
  const segs: [number, number][] = Array.from({ length: n }, (_, i) => [6, (((i >= 5 && i < 10) ? peak : avg) * 1e6 * 6) / 8]);
  return prebufferNeeded(segs, down).waitSec;
}
