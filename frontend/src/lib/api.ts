export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const j = await res.json();
      if (typeof j.detail === "string") msg = j.detail;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, msg);
  }
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(p: string) => request<T>("GET", p),
  post: <T>(p: string, b: unknown = {}) => request<T>("POST", p, b),
  patch: <T>(p: string, b: unknown) => request<T>("PATCH", p, b),
  del: <T>(p: string) => request<T>("DELETE", p),
};

/** delay: shared timing in seconds set by the host, positive shows every line later */
export interface Subtitle {
  lang: string;
  label: string;
  file: string;
  delay?: number;
}

export interface Movie {
  id: string;
  title: string;
  status: "downloading" | "queued" | "processing" | "choose_audio" | "ready" | "needs_transcode" | "failed";
  progress: number;
  duration: number | null;
  size_bytes: number | null;
  video_codec: string | null;
  audio_codec: string | null;
  width: number | null;
  height: number | null;
  codecs: string | null;
  peak_mbps: number | null;
  avg_mbps: number | null;
  note: string | null;
  error: string | null;
  subtitles: Subtitle[];
  audio_tracks: { index: number; codec: string; channels: number; lang: string; title: string; default: boolean }[];
  created_at: number;
  started_at: number | null;
  poster: string | null;
  manifest?: string;
}

export interface MemberInfo {
  id: string;
  name: string;
  admin: boolean;
  connected: boolean;
  state: string;
  pos: number;
  ahead: number;
  rtt: number;
  drift: number;
  mbps: number;
}

export interface Knock {
  id: string;
  name: string;
  since: number;
}

export interface RoomInfo {
  code: string;
  name: string;
  movie: Movie | null;
  created_at: number;
  members: MemberInfo[];
  phase: string;
  pos: number;
  knocks: Knock[];
}

export interface Me {
  admin: boolean;
  guest: { id: string; name: string; room: string; status: string } | null;
}

export interface Profile {
  duration: number;
  init_bytes: number;
  segments: [number, number][];
  avg_mbps: number;
  peak_mbps: number;
}

export interface RoomSession {
  room: { code: string; name: string };
  you: { id: string; name: string; admin: boolean };
  movie: Movie | null;
  profile: Profile | null;
}
