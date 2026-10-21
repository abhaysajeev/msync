// Reconnecting room WebSocket. Typed messages fan out to listeners by `t`.

export type Msg = { t: string; [k: string]: any };
type Listener = (m: Msg) => void;

export type SocketStatus = "connecting" | "open" | "closed" | "ended";

export class RoomSocket {
  private ws: WebSocket | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private statusListeners = new Set<(s: SocketStatus) => void>();
  private backoff = 500;
  private stopped = false;
  private queue: string[] = [];
  status: SocketStatus = "connecting";
  /** The latest room snapshot, for code that starts listening after it arrived. */
  snapshot: Msg | null = null;

  constructor(private code: string) {
    this.connect();
    document.addEventListener("visibilitychange", this.onVisible);
    window.addEventListener("online", this.onVisible);
  }

  private url(): string {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}/ws/rooms/${this.code}`;
  }

  private setStatus(s: SocketStatus) {
    this.status = s;
    this.statusListeners.forEach((f) => f(s));
  }

  private connect = () => {
    if (this.stopped) return;
    this.setStatus("connecting");
    const ws = new WebSocket(this.url());
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 500;
      this.setStatus("open");
      const q = this.queue;
      this.queue = [];
      q.forEach((d) => ws.send(d));
    };
    ws.onmessage = (ev) => {
      let m: Msg;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m.t === "snapshot") this.snapshot = m;
      this.listeners.get(m.t)?.forEach((f) => f(m));
      this.listeners.get("*")?.forEach((f) => f(m));
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      // 4001 replaced by another tab, 4003 not allowed / kicked, 4004 room deleted
      if (ev.code === 4001 || ev.code === 4003 || ev.code === 4004) {
        this.stopped = true;
        this.setStatus("ended");
        this.listeners.get("closed")?.forEach((f) => f({ t: "closed", code: ev.code }));
        return;
      }
      this.setStatus("closed");
      setTimeout(this.connect, this.backoff);
      this.backoff = Math.min(this.backoff * 2, 8000);
    };
  };

  private onVisible = () => {
    // iOS may have killed the socket while backgrounded; reconnect at once on return
    if (document.visibilityState === "visible" && !this.ws && !this.stopped) {
      this.backoff = 500;
      this.connect();
    }
  };

  send(m: Msg, queueIfClosed = false): boolean {
    const data = JSON.stringify(m);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
      return true;
    }
    if (queueIfClosed) this.queue.push(data);
    return false;
  }

  on(t: string, f: Listener): () => void {
    let set = this.listeners.get(t);
    if (!set) this.listeners.set(t, (set = new Set()));
    set.add(f);
    return () => set!.delete(f);
  }

  onStatus(f: (s: SocketStatus) => void): () => void {
    this.statusListeners.add(f);
    return () => this.statusListeners.delete(f);
  }

  /** Test hook: drop the connection as a network blip would. */
  drop(): void {
    this.ws?.close();
  }

  close(): void {
    this.stopped = true;
    document.removeEventListener("visibilitychange", this.onVisible);
    window.removeEventListener("online", this.onVisible);
    this.ws?.close();
  }
}
