import { describe, expect, it } from "vitest";
import { ClockSync } from "./clock";
import { COOLDOWN_MS, DriftPolicy, defaultStrategy } from "./drift";
import { minAheadFor, peakMbps, prebufferNeeded, type Segment } from "./prebuffer";

describe("ClockSync", () => {
  it("recovers the true offset and prefers the lowest-RTT sample", () => {
    const c = new ClockSync();
    const trueOffset = 5000;
    // symmetric 40 ms path, 2 ms server processing
    c.add(100, 100 + 20 + trueOffset, 102 + 20 + trueOffset, 142);
    // asymmetric slow sample (request 300 ms, response 20 ms) would bias the offset
    c.add(200, 200 + 300 + trueOffset, 202 + 300 + trueOffset, 524);
    expect(c.rtt).toBe(40);
    expect(c.offset).toBeCloseTo(trueOffset, 6);
    expect(c.toLocal(c.serverNow(1000))).toBeCloseTo(1000, 6);
  });

  it("keeps only the last N samples", () => {
    const c = new ClockSync(2);
    c.add(0, 10, 10, 2); // rtt 2, offset 9
    c.add(0, 50, 50, 40); // rtt 40
    c.add(0, 60, 60, 50); // rtt 50 - the rtt-2 sample is evicted
    expect(c.rtt).toBe(40);
  });
});

describe("DriftPolicy", () => {
  it("ignores small drift", () => {
    expect(new DriftPolicy("rate").decide(40, 10, 0).type).toBe("none");
  });

  it("nudges rate on Chromium and ends the nudge when close", () => {
    const p = new DriftPolicy("rate");
    expect(p.decide(200, 10, 0)).toEqual({ type: "rate", rate: 0.95 });
    expect(p.decide(100, 10, 500).type).toBe("none");
    expect(p.decide(10, 10, 900)).toEqual({ type: "rate", rate: 1 });
  });

  it("uses micro-pause when ahead and lead-seek when behind on Safari", () => {
    const p = new DriftPolicy("safari");
    expect(p.decide(300, 10, 0)).toEqual({ type: "micropause", ms: 300 });
    const s = p.decide(-300, 20, COOLDOWN_MS + 1);
    expect(s.type).toBe("seek");
    if (s.type === "seek") expect(s.to).toBeCloseTo(20.25, 6);
  });

  it("hard-seeks large drift and respects the cooldown", () => {
    const p = new DriftPolicy("rate");
    expect(p.decide(5000, 100, 0).type).toBe("seek");
    expect(p.decide(5000, 100, 100).type).toBe("none");
  });

  it("escalates to a resync after too many corrections in a minute", () => {
    const p = new DriftPolicy("safari");
    let t = 0;
    const kinds = [];
    for (let i = 0; i < 4; i++) {
      kinds.push(p.decide(500, 10, t).type);
      t += COOLDOWN_MS + 10;
    }
    expect(kinds).toEqual(["micropause", "micropause", "micropause", "resync"]);
  });

  it("detects WebKit", () => {
    const safari = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
    const chrome = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
    const ipadChrome = "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1";
    expect(defaultStrategy(safari)).toBe("safari");
    expect(defaultStrategy(chrome)).toBe("rate");
    expect(defaultStrategy(ipadChrome)).toBe("safari");
  });
});

describe("prebuffer", () => {
  const flat: Segment[] = Array.from({ length: 100 }, () => [6, 3_750_000]); // 5 Mbps

  it("needs no wait beyond one segment when throughput exceeds the bitrate", () => {
    const p = prebufferNeeded(flat, 20);
    expect(p.ok).toBe(true);
    expect(p.waitSec).toBeCloseTo(1.5, 6); // first segment at 20 Mbps
  });

  it("waits proportionally when throughput is below the bitrate", () => {
    // 5 Mbps film over 4 Mbps: total download 750 s for 600 s of film -> wait ~150 s
    const p = prebufferNeeded(flat, 4);
    expect(p.waitSec).toBeCloseTo(750 - 594, 0);
    expect(p.ok).toBe(false);
    expect(p.aheadSec).toBeGreaterThan(100);
  });

  it("respects a bitrate peak early in the film", () => {
    // late peaks are absorbed by the slack a faster link builds up; an early one is not
    const spiky = flat.map((s, i) => (i === 3 ? ([6, 30_000_000] as Segment) : s));
    const base = prebufferNeeded(flat, 6).waitSec;
    expect(prebufferNeeded(spiky, 6).waitSec).toBeGreaterThan(base);
  });

  it("starts the calculation at the seek position", () => {
    const spikyStart = flat.map((s, i) => (i < 5 ? ([6, 20_000_000] as Segment) : s));
    expect(prebufferNeeded(spikyStart, 6, 60).waitSec).toBeLessThan(prebufferNeeded(spikyStart, 6, 0).waitSec);
  });

  it("caps the client buffer target to the player capacity", () => {
    expect(minAheadFor({ waitSec: 1, aheadSec: 6, ok: true }, 8, 180)).toBeCloseTo(10.6, 9);
    expect(minAheadFor({ waitSec: 500, aheadSec: 400, ok: false }, 8, 180)).toBe(162);
  });

  it("finds the peak window", () => {
    expect(peakMbps(flat)).toBeCloseTo(5, 6);
  });
});
