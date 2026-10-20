// Video element + hls.js. One engine everywhere with explicit buffer control:
// MSE on desktop and iPad, ManagedMediaSource on iPhone (iOS 17.1+), native HLS as fallback.
import Hls from "hls.js";

export type Engine = "hls.js" | "native";

export interface PlayerStats {
  engine: Engine;
  mbps: number;          // EWMA of fragment download throughput
  ahead: number;
  capacity: number;      // seconds the player will try to hold
}

const isIOSPhone = () => /iPhone|iPod/.test(navigator.userAgent);

export class Player {
  readonly video: HTMLVideoElement;
  private hls: Hls | null = null;
  engine: Engine = "native";
  mbps = 0;
  capacity = 180;
  private lastFrame = { mediaTime: -1, at: 0 };
  private rvfc = false;
  private listeners = new Set<() => void>();

  constructor(video: HTMLVideoElement) {
    this.video = video;
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "");
    video.preload = "auto";
    video.controls = false;
    // ManagedMediaSource needs remote playback off (or an AirPlay alternative source)
    (video as any).disableRemotePlayback = true;
    this.watchFrames();
  }

  load(manifest: string, startAt = 0): void {
    this.destroyHls();
    const phone = isIOSPhone();
    this.capacity = phone ? 90 : 180;
    if (Hls.isSupported()) {
      this.engine = "hls.js";
      const hls = new Hls({
        maxBufferLength: this.capacity,
        maxMaxBufferLength: this.capacity + 120,
        maxBufferSize: (phone ? 120 : 250) * 1000 * 1000,
        backBufferLength: 30,
        startPosition: startAt,
        enableWorker: true,
        lowLatencyMode: false,
        // one rendition: nothing to switch, never cap quality
        capLevelToPlayerSize: false,
        startFragPrefetch: true,
        fragLoadingMaxRetry: 8,
        manifestLoadingMaxRetry: 6,
      });
      hls.on(Hls.Events.FRAG_LOADED, (_e, data) => {
        const st = data.frag.stats;
        const ms = st.loading.end - st.loading.first;
        if (ms > 30 && st.loaded > 200_000) {
          const m = (st.loaded * 8) / (ms / 1000) / 1e6;
          this.mbps = this.mbps ? this.mbps * 0.7 + m * 0.3 : m;
        }
        this.emit();
      });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
      });
      hls.loadSource(manifest);
      hls.attachMedia(this.video);
      this.hls = hls;
    } else if (this.video.canPlayType("application/vnd.apple.mpegurl")) {
      this.engine = "native";
      this.video.src = manifest;
      if (startAt) {
        const once = () => {
          this.video.currentTime = startAt;
          this.video.removeEventListener("loadedmetadata", once);
        };
        this.video.addEventListener("loadedmetadata", once);
      }
    } else {
      throw new Error("This browser cannot play HLS video.");
    }
  }

  private destroyHls() {
    this.hls?.destroy();
    this.hls = null;
  }

  destroy(): void {
    this.destroyHls();
    this.video.removeAttribute("src");
    this.video.load();
  }

  onChange(f: () => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  private emit() {
    this.listeners.forEach((f) => f());
  }

  // ---- position ------------------------------------------------------------------------------

  private watchFrames() {
    const v = this.video as any;
    if (typeof v.requestVideoFrameCallback !== "function") return;
    this.rvfc = true;
    const cb = (now: number, meta: { mediaTime: number }) => {
      this.lastFrame = { mediaTime: meta.mediaTime, at: now };
      v.requestVideoFrameCallback(cb);
    };
    v.requestVideoFrameCallback(cb);
  }

  /** Best estimate of the presented position, in seconds. */
  position(): number {
    const v = this.video;
    if (this.rvfc && !v.paused && !v.seeking && this.lastFrame.mediaTime >= 0) {
      const age = performance.now() - this.lastFrame.at;
      if (age < 120) return this.lastFrame.mediaTime + (age / 1000) * v.playbackRate;
    }
    return v.currentTime;
  }

  get duration(): number {
    const d = this.video.duration;
    return Number.isFinite(d) ? d : 0;
  }

  /** Seconds buffered contiguously from the current position. */
  ahead(at = this.video.currentTime): number {
    const b = this.video.buffered;
    for (let i = 0; i < b.length; i++) {
      if (b.start(i) - 0.25 <= at && at <= b.end(i) + 0.05) return Math.max(0, b.end(i) - at);
    }
    return 0;
  }

  bufferedRanges(): [number, number][] {
    const b = this.video.buffered;
    const out: [number, number][] = [];
    for (let i = 0; i < b.length; i++) out.push([b.start(i), b.end(i)]);
    return out;
  }

  // ---- control -------------------------------------------------------------------------------

  seek(t: number): Promise<number> {
    const v = this.video;
    const t0 = performance.now();
    if (Math.abs(v.currentTime - t) < 0.02 && !v.seeking) return Promise.resolve(0);
    return new Promise((resolve) => {
      const done = () => {
        v.removeEventListener("seeked", done);
        resolve(performance.now() - t0);
      };
      v.addEventListener("seeked", done);
      v.currentTime = t;
    });
  }

  async play(): Promise<"ok" | "muted" | "blocked"> {
    try {
      await this.video.play();
      return "ok";
    } catch (e: any) {
      if (e?.name !== "NotAllowedError") return "blocked";
      // no user gesture yet: start muted so sync holds, and ask for a tap to unmute
      this.video.muted = true;
      try {
        await this.video.play();
        return "muted";
      } catch {
        return "blocked";
      }
    }
  }

  pause(): void {
    this.video.pause();
  }

  setRate(r: number): void {
    this.video.playbackRate = r;
  }

  /** Nudge hls.js to keep loading while paused (it does by default; native may not). */
  ensureLoading(): void {
    this.hls?.startLoad(this.video.currentTime);
  }

  stats(): PlayerStats {
    return { engine: this.engine, mbps: this.mbps, ahead: this.ahead(), capacity: this.capacity };
  }
}
