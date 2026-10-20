// One outline icon set, 1.5px stroke, drawn on a 24 grid.
import type { JSX } from "preact";

type P = { size?: number; title?: string };

function I({ size = 20, title, children }: P & { children: JSX.Element | JSX.Element[] }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden={title ? undefined : "true"} role={title ? "img" : undefined}>
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

export const Play = (p: P) => <I {...p}><path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none" /></I>;
export const Pause = (p: P) => <I {...p}><rect x="6.5" y="5" width="3.5" height="14" rx="1" fill="currentColor" stroke="none" /><rect x="14" y="5" width="3.5" height="14" rx="1" fill="currentColor" stroke="none" /></I>;
export const Back10 = (p: P) => <I {...p}><path d="M4 12a8 8 0 1 0 2.4-5.7" /><path d="M4 4v4h4" /><path d="M10.5 10v5" /><path d="M13.5 10.5h2v4h-2z" /></I>;
export const Fwd10 = (p: P) => <I {...p}><path d="M20 12a8 8 0 1 1-2.4-5.7" /><path d="M20 4v4h-4" /><path d="M8.5 10v5" /><path d="M11.5 10.5h2v4h-2z" /></I>;
export const Mic = (p: P) => <I {...p}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0" /><path d="M12 17.5V21" /></I>;
export const MicOff = (p: P) => <I {...p}><path d="M15 9.5V6a3 3 0 0 0-5.7-1.3" /><path d="M9 9v2a3 3 0 0 0 4.6 2.5" /><path d="M5.5 11a6.5 6.5 0 0 0 10.6 5" /><path d="M18.5 11c0 .8-.1 1.5-.4 2.2" /><path d="M12 17.5V21" /><path d="M3 3l18 18" /></I>;
export const Cam = (p: P) => <I {...p}><rect x="3" y="6" width="13" height="12" rx="2" /><path d="M16 10.5l5-3v9l-5-3z" /></I>;
export const CamOff = (p: P) => <I {...p}><path d="M10 6h4a2 2 0 0 1 2 2v4" /><path d="M16 10.5l5-3v9l-3.5-2.1" /><path d="M16 16a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2" /><path d="M3 3l18 18" /></I>;
export const Chat = (p: P) => <I {...p}><path d="M4 5h16v11H9l-5 4z" /></I>;
export const Expand = (p: P) => <I {...p}><path d="M4 9V4h5" /><path d="M20 9V4h-5" /><path d="M4 15v5h5" /><path d="M20 15v5h-5" /></I>;
export const Shrink = (p: P) => <I {...p}><path d="M9 4v5H4" /><path d="M15 4v5h5" /><path d="M9 20v-5H4" /><path d="M15 20v-5h5" /></I>;
export const Captions = (p: P) => <I {...p}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M10 10.5a2 2 0 1 0 0 3" /><path d="M16.5 10.5a2 2 0 1 0 0 3" /></I>;
export const Close = (p: P) => <I {...p}><path d="M6 6l12 12M18 6L6 18" /></I>;
export const Copy = (p: P) => <I {...p}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a1 1 0 0 1 1-1h9" /></I>;
export const Upload = (p: P) => <I {...p}><path d="M12 15V4" /><path d="M7.5 8.5L12 4l4.5 4.5" /><path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" /></I>;
export const Link = (p: P) => <I {...p}><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></I>;
export const More = (p: P) => <I {...p}><circle cx="5.5" cy="12" r="1" fill="currentColor" /><circle cx="12" cy="12" r="1" fill="currentColor" /><circle cx="18.5" cy="12" r="1" fill="currentColor" /></I>;
export const Volume = (p: P) => <I {...p}><path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z" /><path d="M15.5 9a4 4 0 0 1 0 6" /><path d="M18 6.5a7.5 7.5 0 0 1 0 11" /></I>;
export const VolumeOff = (p: P) => <I {...p}><path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z" /><path d="M16 9.5l5 5M21 9.5l-5 5" /></I>;
export const Send = (p: P) => <I {...p}><path d="M4 12l16-8-6 16-2.5-6.5z" /></I>;
export const Gauge = (p: P) => <I {...p}><path d="M4.5 17a8.5 8.5 0 1 1 15 0" /><path d="M12 13l4-4" /></I>;
export const ArrowLeft = (p: P) => <I {...p}><path d="M19 12H5" /><path d="M11 6l-6 6 6 6" /></I>;
export const Users = (p: P) => <I {...p}><circle cx="9" cy="8" r="3.5" /><path d="M3 20a6 6 0 0 1 12 0" /><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8" /><path d="M18 14.3A6 6 0 0 1 21 20" /></I>;

/** The product mark: two rings, one in the film's amber, overlapping in sync. */
export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="12" cy="16" r="7.5" fill="none" stroke="var(--accent)" stroke-width="2.5" />
      <circle cx="20" cy="16" r="7.5" fill="none" stroke="var(--text)" stroke-width="2.5" />
    </svg>
  );
}
