// Subtitles on the watch screen: our own cue renderer (so size, position and style work the same
// on every browser and inside fullscreen) and the CC settings sheet.
//
// The <track> elements only load cues (mode "hidden"); each tick we pick the cues active at
// currentTime − delay and draw them. Delay never touches the cues or the file, so it can be
// changed back and forth freely.
import type { RefObject } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { Subtitle } from "../lib/api";
import { fmtDelay } from "./format";
import * as Ic from "./icons";

export interface SubStyle {
  size: number; // scale on the base size
  lift: number; // % of the screen height above the bottom edge
  bg: "shadow" | "box" | "solid";
  color: "white" | "yellow";
}

const STYLE_KEY = "msync:substyle";
const DEFAULT_STYLE: SubStyle = { size: 1, lift: 6, bg: "shadow", color: "white" };

export function loadStyle(): SubStyle {
  try {
    return { ...DEFAULT_STYLE, ...JSON.parse(localStorage.getItem(STYLE_KEY) || "{}") };
  } catch {
    return DEFAULT_STYLE;
  }
}

export function saveStyle(s: SubStyle): void {
  try {
    localStorage.setItem(STYLE_KEY, JSON.stringify(s));
  } catch {
    /* private mode */
  }
}

export function trackFor(v: HTMLVideoElement, file: string): TextTrack | null {
  const el = v.querySelector<HTMLTrackElement>(`track[data-file="${file}"]`);
  return el?.track ?? null;
}

function cueLine(c: TextTrackCue): HTMLElement {
  const line = document.createElement("div");
  line.className = "cue";
  const span = document.createElement("span");
  // getCueAsHTML builds only WebVTT cue markup (i, b, u, ruby…), never arbitrary HTML
  if ("getCueAsHTML" in c) span.append((c as VTTCue).getCueAsHTML());
  else span.textContent = (c as any).text ?? "";
  line.append(span);
  return line;
}

export function SubtitleLayer({ videoRef, file, delay, style, preview }: {
  videoRef: RefObject<HTMLVideoElement>;
  file: string | null;
  delay: number;
  style: SubStyle;
  preview: boolean;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [empty, setEmpty] = useState(true);

  useEffect(() => {
    const box = boxRef.current;
    const v = videoRef.current;
    if (!box) return;
    box.replaceChildren();
    setEmpty(true);
    if (!v || !file) return;
    let shown: TextTrackCue[] = [];
    const tick = () => {
      const cues = trackFor(v, file)?.cues;
      const now = v.currentTime - delay;
      const active: TextTrackCue[] = [];
      if (cues) {
        for (let i = 0; i < cues.length; i++) {
          const c = cues[i];
          if (c.startTime <= now && now < c.endTime) active.push(c);
        }
      }
      if (active.length === shown.length && active.every((c, i) => c === shown[i])) return;
      shown = active;
      box.replaceChildren(...active.map(cueLine));
      setEmpty(active.length === 0);
    };
    tick();
    const id = window.setInterval(tick, 100);
    v.addEventListener("seeked", tick);
    return () => {
      clearInterval(id);
      v.removeEventListener("seeked", tick);
    };
  }, [file, delay]);

  return (
    <div class={`subs-layer bg-${style.bg} color-${style.color}`} aria-live="off"
      style={{ "--sub-scale": String(style.size), "--sub-lift": `${style.lift}%` }}>
      <div ref={boxRef} class="cues" />
      {preview && empty && file && <div class="cue sample"><span>Subtitles will look like this</span></div>}
    </div>
  );
}

function Seg<T extends string | number>({ label, value, options, onPick }: {
  label: string;
  value: T;
  options: [T, string][];
  onPick: (v: T) => void;
}) {
  return (
    <div class="ss-row">
      <span class="ss-label">{label}</span>
      <div class="seg" role="radiogroup" aria-label={label}>
        {options.map(([v, text]) => (
          <button role="radio" aria-checked={v === value} class={v === value ? "on" : ""} onClick={() => onPick(v)}>{text}</button>
        ))}
      </div>
    </div>
  );
}

export function SubtitleSheet(p: {
  subs: Subtitle[];
  file: string | null;
  onPick: (file: string | null) => void;
  delay: number;
  shared: number;
  onDelay: (d: number) => void;
  onSaveShared: () => void;
  saving: boolean;
  admin: boolean;
  style: SubStyle;
  onStyle: (s: SubStyle) => void;
  onClose: () => void;
}) {
  const { subs, file, delay, shared, style } = p;
  const personal = Math.abs(delay - shared) > 0.0005;
  const set = (patch: Partial<SubStyle>) => p.onStyle({ ...style, ...patch });
  const step = (d: number) => p.onDelay(Math.round((delay + d) * 1000) / 1000);

  return (
    <div class="subsheet" role="dialog" aria-label="Subtitle settings" onPointerDown={(e) => e.stopPropagation()}>
      <header>
        <h2>Subtitles</h2>
        <button class="cbtn" aria-label="Close subtitle settings" onClick={p.onClose}><Ic.Close size={18} /></button>
      </header>

      <div class="ss-tracks" role="radiogroup" aria-label="Subtitle track">
        <button role="radio" aria-checked={!file} class={!file ? "on" : ""} onClick={() => p.onPick(null)}>
          <span class="grow">Off</span>{!file && <Ic.Check size={18} />}
        </button>
        {subs.map((s) => (
          <button role="radio" aria-checked={file === s.file} class={file === s.file ? "on" : ""} onClick={() => p.onPick(s.file)}>
            <span class="grow">{s.label}{s.lang && s.lang !== "und" && <small>{s.lang.toUpperCase()}</small>}</span>
            {file === s.file && <Ic.Check size={18} />}
          </button>
        ))}
        {subs.length === 0 && (
          <p class="ss-note">{p.admin ? "No subtitles for this film yet. Add them from the film's menu on Movie nights." : "No subtitles for this film yet."}</p>
        )}
      </div>

      {file && (
        <>
          <div class="ss-row col">
            <span class="ss-label">Timing</span>
            <div class="ss-delay" role="group" aria-label="Subtitle delay">
              <button onClick={() => step(-0.5)} aria-label="Earlier by half a second">−0.5</button>
              <button onClick={() => step(-0.1)} aria-label="Earlier by a tenth of a second">−0.1</button>
              <output class="num" aria-live="polite">{fmtDelay(delay)}</output>
              <button onClick={() => step(0.1)} aria-label="Later by a tenth of a second">+0.1</button>
              <button onClick={() => step(0.5)} aria-label="Later by half a second">+0.5</button>
            </div>
            <p class="ss-note">
              {personal ? "Only on this device." : shared ? "Shared timing for both of you." : "Lines too early? Press +. Too late? Press −."}
              <span class="hide-sm"> Keys: G earlier, H later.</span>
            </p>
            {(personal || (p.admin && shared !== 0)) && (
              <div class="ss-actions">
                {personal && <button class="text-btn" onClick={() => p.onDelay(shared)}>{shared ? `Back to shared (${fmtDelay(shared)})` : "Reset"}</button>}
                {p.admin && !personal && shared !== 0 && <button class="text-btn" onClick={() => p.onDelay(0)}>Reset</button>}
                {p.admin && personal && (
                  <button class="btn sm primary" disabled={p.saving} onClick={p.onSaveShared}>{p.saving ? "Saving…" : "Save for both"}</button>
                )}
              </div>
            )}
          </div>

          <Seg label="Size" value={style.size} onPick={(size) => set({ size })}
            options={[[0.8, "S"], [1, "M"], [1.3, "L"], [1.65, "XL"]]} />
          <Seg label="Position" value={style.lift} onPick={(lift) => set({ lift })}
            options={[[2, "Low"], [6, "Normal"], [14, "Raised"], [24, "High"]]} />
          <Seg label="Style" value={style.bg} onPick={(bg) => set({ bg })}
            options={[["shadow", "Shadow"], ["box", "Box"], ["solid", "Solid"]]} />
          <Seg label="Colour" value={style.color} onPick={(color) => set({ color })}
            options={[["white", "White"], ["yellow", "Yellow"]]} />
        </>
      )}
    </div>
  );
}
