// Built-in connection check against this server: latency, download and upload.
// Download uses incompressible bytes, timed from the first byte so latency is not counted twice.

export interface SpeedResult {
  downMbps: number;
  upMbps: number;
  latencyMs: number;
}

async function timedDownload(bytes: number): Promise<number> {
  const res = await fetch(`/api/bw?bytes=${bytes}&n=${Math.random()}`, { cache: "no-store", credentials: "same-origin" });
  if (!res.ok || !res.body) throw new Error(res.status === 403 ? "Open your invite link first." : "Speed test failed.");
  const reader = res.body.getReader();
  let first = 0;
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!first) first = performance.now();
    got += value.byteLength;
  }
  const secs = Math.max(0.001, (performance.now() - first) / 1000);
  return (got * 8) / secs / 1e6;
}

async function latency(n = 5): Promise<number> {
  const xs: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await fetch(`/api/health?n=${Math.random()}`, { cache: "no-store" });
    xs.push(performance.now() - t0);
  }
  xs.sort((a, b) => a - b);
  return xs[Math.floor(xs.length / 2)];
}

async function upload(bytes: number): Promise<number> {
  const blob = new Blob([crypto.getRandomValues(new Uint8Array(65536))]);
  const parts = Array.from({ length: Math.ceil(bytes / 65536) }, () => blob);
  const body = new Blob(parts);
  const t0 = performance.now();
  const res = await fetch("/api/bw/up", { method: "POST", body, cache: "no-store", credentials: "same-origin" });
  if (!res.ok) throw new Error("Upload test failed.");
  await res.json();
  return (body.size * 8) / ((performance.now() - t0) / 1000) / 1e6;
}

export async function speedTest(onStep?: (step: string, partial: Partial<SpeedResult>) => void): Promise<SpeedResult> {
  const out: Partial<SpeedResult> = {};
  onStep?.("latency", out);
  out.latencyMs = await latency();
  onStep?.("download", out);
  await timedDownload(1 << 20); // warm up the TCP window
  let down = await timedDownload(8 << 20);
  if (down > 40) down = Math.max(down, await timedDownload(32 << 20));
  out.downMbps = down;
  onStep?.("upload", out);
  out.upMbps = await upload(2 << 20);
  onStep?.("done", out);
  return out as SpeedResult;
}
