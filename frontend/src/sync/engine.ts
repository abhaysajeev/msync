// Client side of the sync protocol (see backend/app/sync/room_state.py for the server).
//
// The engine applies server commands to the player and reports status. It never broadcasts
// media-element events: only explicit user intents (and system pauses such as AirPods
// coming out) go to the server, so there is no echo loop by construction.
import type { Profile } from "../lib/api";
import type { Msg, RoomSocket } from "../lib/socket";
import type { Player } from "../player/player";
import { ClockSync, localNow } from "./clock";
import { DriftPolicy, defaultStrategy, type Strategy } from "./drift";
import { minAheadFor, prebufferNeeded, secondsWithinBytes } from "./prebuffer";

export type Phase = "paused" | "preparing" | "playing";
export type LocalState = "loading" | "ready" | "buffering" | "playing" | "paused";
export type Blocked = "none" | "muted" | "tap";

export interface EngineView {
  phase: Phase;
  seq: number;
  localState: LocalState;
  target: number;
  reason: string;
  waitingFor: string[];
  blocked: Blocked;
  drift: number;
  rtt: number;
  offset: number;
  ahead: number;
  needAhead: number;
  mbps: number;
  strategy: Strategy;
  corrections: number;
  lastCorrection: string;
}

const TICK_MS = 250;
const STATUS_MS = 1000;
const PING_MS = 10_000;
const STALL_REPORT_MS = 300;
const CATCH_UP_STALL_MS = 1500;
const MIN_START_AHEAD = 4; // a full-but-short buffer still has to hold this much

export class SyncEngine {
  // server state
  seq = -1;
  phase: Phase = "paused";
  pos = 0;
  anchor = 0;
  wantPlaying = false;
  minAhead = 8;
  reason = "";
  waitingFor: string[] = [];

  // local
  readonly clock = new ClockSync();
  readonly policy: DriftPolicy;
  localState: LocalState = "loading";
  blocked: Blocked = "none";
  drift = 0;
  needAhead = 0;
  corrections = 0;
  lastCorrection = "";
  /** The host started without us for this seq: catch up alone instead of stalling the room. */
  excused = false;

  private op = 0;
  private catchingUp = false;
  private selfPause = 0;
  private selfPlay = 0;
  private microPausing = false;
  private waitingSince = 0;
  private stallReportedSeq = -1;
  private startTimer: number | undefined;
  private timers: number[] = [];
  private offs: (() => void)[] = [];
  private listeners = new Set<() => void>();
  private clockWaiters: (() => void)[] = [];
  private lastStatus = 0;

  constructor(
    private socket: RoomSocket,
    private player: Player,
    private profile: Profile | null,
    private me: string,
    strategy: Strategy = defaultStrategy(),
  ) {
    const forced = new URLSearchParams(location.search).get("sync");
    this.policy = new DriftPolicy(forced === "rate" || forced === "safari" ? forced : strategy);
  }

  // ---- lifecycle ---------------------------------------------------------------------------

  start(): void {
    const s = this.socket;
    this.offs.push(
      s.on("pong", this.onPong),
      s.on("snapshot", (m) => this.applySnapshot(m)),
      s.on("cmd", (m) => this.applyCmd(m)),
      s.on("rejected", () => this.emit()),
      s.on("notice", (m) => {
        if (m.kind === "waiting" && m.seq === this.seq) {
          this.waitingFor = m.names ?? [];
          this.emit();
        }
      }),
      s.onStatus((st) => {
        if (st === "open") this.burst();
      }),
    );
    const v = this.player.video;
    const on = (ev: string, f: () => void) => {
      v.addEventListener(ev, f);
      this.offs.push(() => v.removeEventListener(ev, f));
    };
    on("waiting", () => (this.waitingSince = this.waitingSince || localNow()));
    on("playing", () => (this.waitingSince = 0));
    on("canplay", () => (this.waitingSince = 0));
    on("pause", this.onMediaPause);
    on("play", this.onMediaPlay);
    on("volumechange", () => {
      if (!v.muted && this.blocked === "muted") {
        this.blocked = "none";
        this.emit();
      }
    });
    const vis = () => {
      if (document.visibilityState === "visible") this.burst();
    };
    document.addEventListener("visibilitychange", vis);
    this.offs.push(() => document.removeEventListener("visibilitychange", vis));

    this.timers.push(
      window.setInterval(() => this.tick(), TICK_MS),
      window.setInterval(() => this.ping(), PING_MS),
    );
    if (this.socket.status === "open") this.burst();
  }

  stop(): void {
    this.offs.forEach((f) => f());
    this.timers.forEach((t) => clearInterval(t));
    clearTimeout(this.startTimer);
    this.op++;
  }

  subscribe(f: () => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  private emit() {
    this.listeners.forEach((f) => f());
  }

  view(): EngineView {
    return {
      phase: this.phase, seq: this.seq, localState: this.localState, target: this.target(),
      reason: this.reason, waitingFor: this.waitingFor, blocked: this.blocked,
      drift: this.drift, rtt: this.clock.rtt, offset: this.clock.offset,
      ahead: this.player.ahead(), needAhead: this.needAhead, mbps: this.player.mbps,
      strategy: this.policy.strategy, corrections: this.corrections, lastCorrection: this.lastCorrection,
    };
  }

  // ---- clock -------------------------------------------------------------------------------

  private ping = () => {
    this.socket.send({ t: "ping", t0: localNow() });
  };

  private burst() {
    for (let i = 0; i < 8; i++) window.setTimeout(this.ping, i * 150);
  }

  private onPong = (m: Msg) => {
    this.clock.add(m.t0, m.t1, m.t2, localNow());
    const w = this.clockWaiters;
    this.clockWaiters = [];
    w.forEach((f) => f());
  };

  private clockReady(): Promise<void> {
    if (this.clock.ready) return Promise.resolve();
    return new Promise((res) => {
      this.clockWaiters.push(res);
      window.setTimeout(res, 2000);
    });
  }

  serverNow(): number {
    return this.clock.serverNow();
  }

  /** Where the room is right now, in film seconds. */
  target(): number {
    if (this.phase !== "playing") return this.pos;
    const now = this.serverNow();
    if (now < this.anchor) return this.pos;
    return this.pos + (now - this.anchor) / 1000;
  }

  // ---- user intents ------------------------------------------------------------------------

  play(): boolean {
    this.unmuteIfMuted();
    return this.socket.send({ t: "intent", kind: "play", base_seq: this.seq });
  }

  pause(): boolean {
    return this.socket.send({ t: "intent", kind: "pause", base_seq: this.seq });
  }

  seek(pos: number): boolean {
    return this.socket.send({ t: "intent", kind: "seek", pos, base_seq: this.seq });
  }

  forceStart(): boolean {
    return this.socket.send({ t: "intent", kind: "force", base_seq: this.seq });
  }

  /** The user tapped "Tap for sound" or "Tap to watch". A real gesture, so play() works. */
  async unblock(): Promise<void> {
    this.player.video.muted = false;
    this.blocked = "none";
    if (this.phase === "playing" && this.serverNow() >= this.anchor) {
      await this.player.seek(this.target() + this.policy.seekCostMs / 1000);
      await this.playLocal();
    }
    this.emit();
  }

  private unmuteIfMuted() {
    if (this.blocked === "muted") {
      this.player.video.muted = false;
      this.blocked = "none";
    }
  }

  // ---- applying server state ---------------------------------------------------------------

  private async applySnapshot(m: Msg) {
    await this.clockReady();
    this.seq = m.seq;
    this.phase = m.phase;
    this.pos = m.pos;
    this.anchor = m.anchor;
    this.wantPlaying = m.want_playing;
    this.minAhead = m.min_ahead;
    this.reason = m.reason;
    this.waitingFor = [];
    const op = ++this.op;
    if (m.phase === "playing") {
      const v = this.player.video;
      const drift = (this.player.position() - this.target()) * 1000;
      if (this.serverNow() < this.anchor) this.scheduleStart(op, m.pos, m.anchor);
      // a reconnect while still playing fine: keep going, the drift loop tidies up
      else if (!v.paused && v.readyState >= 3 && Math.abs(drift) < 1000) this.setLocal("playing");
      else await this.joinPlaying(op);
    } else if (m.phase === "preparing") {
      await this.prepare(op, m.seq, m.pos, m.min_ahead);
    } else {
      await this.holdAt(op, m.pos);
    }
    this.emit();
  }

  private async applyCmd(m: Msg) {
    if (m.seq < this.seq) return; // stale
    await this.clockReady();
    if (m.kind === "start") {
      if (m.seq !== this.seq) return;
      this.excused = Array.isArray(m.excused) && m.excused.includes(this.me);
      this.phase = "playing";
      this.pos = m.pos;
      this.anchor = m.at;
      this.waitingFor = [];
      this.scheduleStart(++this.op, m.pos, m.at);
      this.emit();
      return;
    }
    this.seq = m.seq;
    this.excused = false;
    this.reason = m.reason ?? m.by ?? "";
    this.waitingFor = [];
    const op = ++this.op;
    clearTimeout(this.startTimer);
    if (m.kind === "prepare") {
      this.phase = "preparing";
      this.wantPlaying = true;
      this.pos = m.pos;
      this.minAhead = m.min_ahead;
      this.emit();
      await this.prepare(op, m.seq, m.pos, m.min_ahead);
    } else if (m.kind === "pause") {
      this.phase = "paused";
      this.wantPlaying = false;
      this.pos = m.pos;
      this.emit();
      await this.holdAt(op, m.pos);
    }
    this.emit();
  }

  private async holdAt(op: number, pos: number) {
    this.pauseLocal();
    this.player.setRate(1);
    this.policy.rateActive = false;
    if (Math.abs(this.player.video.currentTime - pos) > 0.05) await this.player.seek(pos);
    if (op !== this.op) return;
    this.setLocal("paused");
  }

  private async prepare(op: number, seq: number, pos: number, serverMin: number) {
    this.setLocal("loading");
    this.pauseLocal();
    this.player.setRate(1);
    this.policy.rateActive = false;
    if (Math.abs(this.player.video.currentTime - pos) > 0.05) await this.player.seek(pos);
    while (op === this.op) {
      const need = this.requiredAhead(pos, serverMin);
      this.needAhead = need;
      const ahead = this.player.ahead();
      const nativeReady = this.player.engine === "native" && this.player.video.readyState >= 4 && ahead >= Math.min(need, 6);
      // the player stopped fetching short of `need` (browser storage quota): this is all it
      // will ever hold, so waiting longer would wait forever
      const fullReady = this.player.full() && ahead >= Math.min(need, MIN_START_AHEAD);
      if (ahead >= need || nativeReady || fullReady) break;
      await sleep(200);
    }
    if (op !== this.op || seq !== this.seq) return;
    this.setLocal("ready");
    this.report(true);
  }

  private requiredAhead(pos: number, serverMin: number): number {
    const dur = this.player.duration || this.profile?.duration || Infinity;
    const remaining = Math.max(0.5, dur - pos - 0.5);
    let need = serverMin;
    if (this.profile && this.player.mbps > 0) {
      const p = prebufferNeeded(this.profile.segments, this.player.mbps, pos, this.player.capacity);
      need = minAheadFor(p, serverMin, this.player.capacity);
    }
    // never ask for more film than the browser can hold at this bitrate
    const holdable = this.profile ? secondsWithinBytes(this.profile.segments, pos, this.player.budgetBytes) : Infinity;
    return Math.max(Math.min(need, remaining, this.player.capacity * 0.9, holdable), Math.min(MIN_START_AHEAD, remaining));
  }

  private scheduleStart(op: number, pos: number, at: number) {
    clearTimeout(this.startTimer);
    const go = async () => {
      if (op !== this.op) return;
      // spin the last few ms for accuracy (setTimeout is only ~4 ms precise at best)
      while (this.serverNow() < at) {
        if (at - this.serverNow() > 20) {
          this.startTimer = window.setTimeout(go, at - this.serverNow() - 15);
          return;
        }
      }
      if (this.excused && this.player.ahead(pos) < 2) {
        void this.catchUp(op);
        return;
      }
      const late = (this.serverNow() - at) / 1000;
      if (late > 0.25) await this.player.seek(pos + late + this.policy.seekCostMs / 1000);
      if (op !== this.op) return;
      await this.playLocal();
    };
    if (Math.abs(this.player.video.currentTime - pos) > 0.05 && this.serverNow() < at - 300) {
      void this.player.seek(pos);
    }
    const delay = at - this.serverNow();
    this.startTimer = window.setTimeout(go, Math.max(0, delay - 15));
  }

  /**
   * Get in step alone while the room plays on (the host started without us). Seeking straight
   * to the room's position chases it: by the time that segment arrives the room has moved on.
   * So seek ahead of it, buffer there, and start the moment the room reaches that point.
   */
  private async catchUp(op: number) {
    if (this.catchingUp) return;
    this.catchingUp = true;
    try {
      this.setLocal("loading");
      this.pauseLocal();
      this.player.setRate(1);
      this.policy.rateActive = false;
      const dur = this.player.duration || this.profile?.duration || Infinity;
      let lead = Math.max(6, (2 * this.policy.seekCostMs) / 1000);
      while (op === this.op && this.phase === "playing") {
        const p = Math.min(this.target() + lead, dur - 1);
        await this.player.seek(p);
        while (op === this.op && this.player.ahead() < MIN_START_AHEAD && this.target() < p - 0.3) await sleep(100);
        if (op !== this.op) return;
        if (this.target() < p - 0.3 || p >= dur - 1) {
          this.scheduleStart(op, p, this.anchor + (p - this.pos) * 1000);
          return;
        }
        lead = Math.min(lead * 2, 120); // the link is slower than that: aim further ahead
      }
    } finally {
      this.catchingUp = false;
    }
  }

  private async joinPlaying(op: number) {
    this.setLocal("loading");
    const t = this.target() + this.policy.seekCostMs / 1000;
    await this.player.seek(t);
    if (op !== this.op) return;
    await this.playLocal();
  }

  private async playLocal() {
    // count only plays that will fire a `play` event, or a later real one gets swallowed
    if (this.player.video.paused) this.selfPlay++;
    const r = await this.player.play();
    if (r === "muted") this.blocked = "muted";
    if (r === "blocked") {
      this.blocked = "tap";
      this.selfPlay = 0;
    }
    this.setLocal(r === "blocked" ? "paused" : "playing");
  }

  private pauseLocal() {
    if (!this.player.video.paused) {
      this.selfPause++;
      this.player.pause();
    }
  }

  private setLocal(s: LocalState) {
    if (this.localState !== s) {
      this.localState = s;
      this.report(true);
      this.emit();
    }
  }

  // ---- media events not caused by us -------------------------------------------------------

  private onMediaPause = () => {
    // nothing is known about the room until the first snapshot; events before it are ours
    // (the Join tap's play/pause that unlocks autoplay)
    if (this.seq < 0) return;
    if (this.selfPause > 0) {
      this.selfPause--;
      return;
    }
    if (this.microPausing) return;
    // AirPods out, a phone call, the lock-screen button: pause the room so nobody runs ahead
    if (this.phase === "playing" && this.serverNow() >= this.anchor) this.pause();
  };

  private onMediaPlay = () => {
    if (this.seq < 0) return;
    if (this.selfPlay > 0) {
      this.selfPlay--;
      return;
    }
    if (this.microPausing) return;
    if (this.phase === "paused") this.play();
  };

  // ---- the loop ----------------------------------------------------------------------------

  private tick() {
    const v = this.player.video;
    const now = localNow();
    if (this.phase === "playing" && this.serverNow() >= this.anchor + 300) {
      // stall watchdog
      if (this.waitingSince && now - this.waitingSince > STALL_REPORT_MS && v.readyState < 3 && this.excused) {
        if (now - this.waitingSince > CATCH_UP_STALL_MS) void this.catchUp(this.op);
      } else if (this.waitingSince && now - this.waitingSince > STALL_REPORT_MS && v.readyState < 3) {
        this.setLocal("buffering");
        if (this.stallReportedSeq !== this.seq) {
          this.stallReportedSeq = this.seq;
          this.report(true);
        }
      } else if (!v.paused && !v.seeking && !this.microPausing && v.readyState >= 3) {
        if (this.localState !== "playing") this.setLocal("playing");
        this.correctDrift();
      } else if (v.paused && !this.microPausing && this.blocked === "none" && this.localState === "playing") {
        void this.playLocal();
      }
    }
    if (now - this.lastStatus > STATUS_MS) this.report();
    this.emit();
  }

  private correctDrift() {
    const target = this.target();
    this.drift = (this.player.position() - target) * 1000;
    const c = this.policy.decide(this.drift, target, localNow());
    if (c.type === "none") return;
    this.corrections++;
    this.lastCorrection = `${c.type} at ${Math.round(this.drift)} ms`;
    const op = this.op;
    switch (c.type) {
      case "rate":
        this.player.setRate(c.rate);
        break;
      case "micropause":
        this.microPausing = true;
        this.player.pause();
        window.setTimeout(async () => {
          if (op === this.op) await this.player.play();
          this.microPausing = false;
        }, c.ms);
        break;
      case "seek": {
        if (this.excused && this.player.ahead(c.to) < 1) {
          void this.catchUp(op);
          break;
        }
        const t0 = performance.now();
        this.player.setRate(1);
        void this.player.seek(c.to).then(() => {
          const v = this.player.video;
          const done = () => {
            v.removeEventListener("playing", done);
            this.policy.learnSeekCost(performance.now() - t0);
          };
          if (!v.paused && v.readyState >= 3) this.policy.learnSeekCost(performance.now() - t0);
          else v.addEventListener("playing", done);
        });
        break;
      }
      case "resync":
        // repeated corrections: run a full barrier for everyone
        this.socket.send({ t: "status", seq: this.seq, state: "buffering", pos: this.player.position(), ahead: this.player.ahead() });
        break;
    }
  }

  private report(force = false) {
    const now = localNow();
    if (!force && now - this.lastStatus < STATUS_MS) return;
    this.lastStatus = now;
    this.socket.send({
      t: "status", seq: this.seq, state: this.localState, pos: this.player.position(),
      ahead: this.player.ahead(), need: this.needAhead, rtt: this.clock.rtt, drift: Math.round(this.drift), mbps: this.player.mbps,
    });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
