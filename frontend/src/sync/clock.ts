// NTP-style clock offset estimation against the server's monotonic clock.
// offset = serverTime - localTime, taken from the lowest-RTT sample of the last 8.

export interface ClockSample {
  offset: number;
  rtt: number;
  at: number;
}

export const localNow = (): number => performance.now();

export class ClockSync {
  private samples: ClockSample[] = [];
  constructor(private keep = 8) {}

  /** t0 client send, t1 server receive, t2 server send, t3 client receive. */
  add(t0: number, t1: number, t2: number, t3: number): ClockSample {
    const rtt = Math.max(0, t3 - t0 - (t2 - t1));
    const offset = (t1 - t0 + (t2 - t3)) / 2;
    const s = { offset, rtt, at: t3 };
    this.samples.push(s);
    if (this.samples.length > this.keep) this.samples.shift();
    return s;
  }

  reset(): void {
    this.samples = [];
  }

  get ready(): boolean {
    return this.samples.length > 0;
  }

  private best(): ClockSample | undefined {
    let b: ClockSample | undefined;
    for (const s of this.samples) if (!b || s.rtt < b.rtt) b = s;
    return b;
  }

  get offset(): number {
    return this.best()?.offset ?? 0;
  }

  get rtt(): number {
    return this.best()?.rtt ?? 0;
  }

  serverNow(local = localNow()): number {
    return local + this.offset;
  }

  toLocal(serverMs: number): number {
    return serverMs - this.offset;
  }
}
