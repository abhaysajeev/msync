// Drift correction policy. Pure: given the measured drift, returns what to do.
//
// Chromium and Firefox: nudge playbackRate for small drift (pitch is preserved).
// Safari/iOS: rate changes stall and warp audio (WebKit 163433, 225868), so ahead-drift is
// fixed with a micro-pause and behind-drift with a seek that leads by the learned seek cost.
// Hysteresis: a cooldown after each action, and too many corrections escalate to a resync.

export type Strategy = "rate" | "safari";

export type Correction =
  | { type: "none" }
  | { type: "rate"; rate: number }
  | { type: "micropause"; ms: number }
  | { type: "seek"; to: number }
  | { type: "resync" };

export const TOLERANCE_MS = 60;
export const RATE_STOP_MS = 20;
export const HARD_MS = 1000;
export const COOLDOWN_MS = 2000;
export const MAX_PER_MINUTE = 3;

export class DriftPolicy {
  private lastActionAt = -Infinity;
  private history: number[] = [];
  rateActive = false;
  /** EWMA of how long a seek takes to resume playing, in ms. */
  seekCostMs = 250;

  constructor(public strategy: Strategy) {}

  learnSeekCost(ms: number): void {
    if (ms > 0 && ms < 5000) this.seekCostMs = this.seekCostMs * 0.7 + ms * 0.3;
  }

  /**
   * @param driftMs positive = this client is ahead of where the room is
   * @param target  room position in seconds right now
   */
  decide(driftMs: number, target: number, now: number): Correction {
    const abs = Math.abs(driftMs);

    // an active rate nudge ends as soon as we are close again, regardless of cooldown
    if (this.rateActive) {
      if (abs < RATE_STOP_MS || abs > HARD_MS) {
        this.rateActive = false;
        if (abs <= HARD_MS) return { type: "rate", rate: 1 };
      } else {
        return { type: "none" };
      }
    }

    if (abs < TOLERANCE_MS) return { type: "none" };
    if (now - this.lastActionAt < COOLDOWN_MS) return { type: "none" };

    this.history = this.history.filter((t) => now - t < 60_000);
    if (this.history.length >= MAX_PER_MINUTE) {
      this.history = [];
      this.lastActionAt = now;
      return { type: "resync" };
    }
    this.history.push(now);
    this.lastActionAt = now;

    if (abs > HARD_MS) {
      return { type: "seek", to: target + this.seekCostMs / 1000 };
    }
    if (this.strategy === "rate") {
      this.rateActive = true;
      return { type: "rate", rate: driftMs > 0 ? 0.95 : 1.05 };
    }
    if (driftMs > 0) return { type: "micropause", ms: Math.round(driftMs) };
    return { type: "seek", to: target + this.seekCostMs / 1000 };
  }
}

/** Safari and every iOS browser are WebKit. */
export function defaultStrategy(ua = typeof navigator !== "undefined" ? navigator.userAgent : ""): Strategy {
  const webkitOnly = /AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg|Firefox|FxiOS|CriOS|EdgiOS/.test(ua);
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && typeof document !== "undefined" && "ontouchend" in document);
  return webkitOnly || ios ? "safari" : "rate";
}
