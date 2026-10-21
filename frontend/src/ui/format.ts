export function clock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** "2 h 49 m" for lengths. */
export function length(sec: number | null | undefined): string {
  if (!sec) return "—";
  const m = Math.round(sec / 60);
  const h = Math.floor(m / 60);
  return h ? `${h} h ${String(m % 60).padStart(2, "0")} m` : `${m} m`;
}

export function gb(bytes: number | null | undefined): string {
  if (!bytes) return "—";
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

export function mbps(x: number | null | undefined, digits = 1): string {
  if (!x || !Number.isFinite(x)) return "—";
  return x.toFixed(x >= 100 ? 0 : digits);
}

export function ago(epochSec: number): string {
  const d = Math.max(0, Date.now() / 1000 - epochSec);
  if (d < 60) return `${Math.round(d)} s`;
  if (d < 3600) return `${Math.round(d / 60)} min`;
  return `${Math.round(d / 3600)} h`;
}

export function hhmm(epochSec: number): string {
  return new Date(epochSec * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** The two people get stable pale tints of their own, far apart in hue. Identity, not data. */
export function personTint(isAdmin: boolean): { background: string; color: string } {
  return isAdmin ? { background: "#1c3532", color: "#8fd9cd" } : { background: "#3b2228", color: "#f2a7b4" };
}

export function initial(name: string): string {
  return (name.trim()[0] || "?").toUpperCase();
}

export function resolution(w?: number | null, h?: number | null): string {
  if (!w || !h) return "";
  if (h >= 2000 || w >= 3800) return "4K";
  if (h >= 1000 || w >= 1900) return "1080p";
  if (h >= 700 || w >= 1260) return "720p";
  return `${h}p`;
}

export function codecLabel(c?: string | null): string {
  if (!c) return "";
  return ({ h264: "H.264", hevc: "HEVC", av1: "AV1", vp9: "VP9", mpeg2video: "MPEG-2", vc1: "VC-1", aac: "AAC", ac3: "AC-3", eac3: "E-AC-3", dts: "DTS", truehd: "TrueHD", flac: "FLAC", opus: "Opus", mp3: "MP3" } as Record<string, string>)[c] ?? c.toUpperCase();
}

/** subtitle delay: +0.50 s means every line shows half a second later */
export function fmtDelay(d: number): string {
  if (Math.abs(d) < 0.0005) return "0.00 s";
  return `${d > 0 ? "+" : "−"}${Math.abs(d).toFixed(2)} s`;
}
