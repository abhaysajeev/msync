// How much must be buffered before starting so playback never runs dry at a given throughput.
//
// Segment i must finish downloading before playback reaches its start:
//   wait + start_i >= downloadEnd_i   =>   wait = max_i(downloadEnd_i - start_i)
// The answer respects bitrate peaks, not just the average.

export type Segment = [duration: number, bytes: number];

export interface Prebuffer {
  waitSec: number;   // how long the start must wait at this throughput
  aheadSec: number;  // seconds of film that will be buffered by then
  ok: boolean;       // throughput covers the film with no wait at all
}

export function prebufferNeeded(segments: Segment[], mbps: number, fromSec = 0, horizonSec = Infinity): Prebuffer {
  if (!segments.length || mbps <= 0) return { waitSec: Infinity, aheadSec: 0, ok: false };
  const bytesPerSec = (mbps * 1e6) / 8;

  // first segment containing fromSec
  let i0 = 0;
  let t = 0;
  while (i0 < segments.length && t + segments[i0][0] <= fromSec) {
    t += segments[i0][0];
    i0++;
  }

  let wait = 0;
  let cumBytes = 0;
  let start = 0; // playback time from the start point
  const ends: number[] = [];
  for (let i = i0; i < segments.length && start < horizonSec; i++) {
    const [dur, bytes] = segments[i];
    cumBytes += bytes;
    const dlEnd = cumBytes / bytesPerSec;
    ends.push(dlEnd);
    wait = Math.max(wait, dlEnd - start);
    start += dur;
  }

  // media buffered by the time we have waited `wait` seconds
  let ahead = 0;
  for (let k = 0; k < ends.length; k++) {
    if (ends[k] <= wait + 1e-9) ahead += segments[i0 + k][0];
    else break;
  }
  return { waitSec: wait, aheadSec: ahead, ok: wait <= segments[i0]?.[0] + 1e-9 };
}

/** The buffer target this client should reach before reporting ready. */
export function minAheadFor(p: Prebuffer, serverMin: number, capacitySec: number): number {
  const own = Number.isFinite(p.aheadSec) ? p.aheadSec * 1.1 + 4 : capacitySec;
  return Math.min(Math.max(serverMin, own), capacitySec * 0.9);
}

/** Peak bitrate over a sliding window, in Mbps. */
export function peakMbps(segments: Segment[], windowSec = 30): number {
  let peak = 0;
  let j = 0;
  let d = 0;
  let b = 0;
  for (let i = 0; i < segments.length; i++) {
    while (j < segments.length && d < windowSec) {
      d += segments[j][0];
      b += segments[j][1];
      j++;
    }
    if (d > 0) peak = Math.max(peak, (b * 8) / d / 1e6);
    d -= segments[i][0];
    b -= segments[i][1];
  }
  return peak;
}

/** Seconds of film from `fromSec` whose segments fit in `bytes` (what the browser can hold). */
export function secondsWithinBytes(segments: Segment[], fromSec: number, bytes: number): number {
  let t = 0;
  let held = 0;
  let total = 0;
  for (const [dur, size] of segments) {
    if (t + dur > fromSec) {
      if (total + size > bytes) break;
      total += size;
      held += dur - Math.max(0, fromSec - t);
    }
    t += dur;
  }
  return held;
}
