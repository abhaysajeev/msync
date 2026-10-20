// End-to-end sync tests: a host in Chromium and a guest in Chromium or WebKit (GUEST=webkit),
// against a running stack. Positions are compared on the machine's own wall clock
// (performance.timeOrigin + now), independent of the app's clock sync, so the measured drift
// is real.
//
//   ADMIN_PASSWORD=... BASE_URL=https://localhost npx playwright test
//   DRIFT_SECONDS=300 for the long drift run from the test plan.
import { chromium, expect, test, webkit, type Browser, type BrowserContext, type Page, type Route } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import * as tus from "tus-js-client";

const BASE = process.env.BASE_URL ?? "https://localhost";
const PASSWORD = process.env.ADMIN_PASSWORD ?? "localtest123";
const DRIFT_SECONDS = Number(process.env.DRIFT_SECONDS ?? 20);
const GUEST = process.env.GUEST ?? "chromium";
const FILM = resolve(process.env.TEST_FILM ?? "../sync-test.mp4");

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // local Caddy uses its own CA

let hostBrowser: Browser;
let guestBrowser: Browser;
let host: BrowserContext;
let guest: BrowserContext;
let hostPage: Page;
let guestPage: Page;
let code = "";
let cookie = "";

async function apiCall(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(BASE + path, { ...init, headers: { "content-type": "application/json", cookie, ...(init.headers ?? {}) } });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function ensureFilm(): Promise<string> {
  const movies = await apiCall("/api/movies");
  const ready = movies.find((m: any) => m.title === "sync test" && m.status === "ready");
  if (ready) return ready.id;
  if (!existsSync(FILM)) execFileSync("../tools/make-sync-test-video.sh", ["3", FILM], { stdio: "inherit" });
  const size = statSync(FILM).size;
  await new Promise<void>((ok, fail) => {
    const up = new tus.Upload(readFileSync(FILM), {
      endpoint: `${BASE}/files/`,
      uploadSize: size,
      chunkSize: 16 * 1024 * 1024,
      headers: { cookie },
      metadata: { filename: "sync-test.mp4", title: "sync test" },
      onError: fail,
      onSuccess: () => ok(),
    });
    up.start();
  });
  for (let i = 0; i < 180; i++) {
    const m = (await apiCall("/api/movies")).find((x: any) => x.title === "sync test");
    if (m?.status === "ready") return m.id;
    if (m?.status === "failed") throw new Error(`processing failed: ${m.error}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("film never became ready");
}

/** [wall-clock ms, video position s, paused] sampled inside the page. */
async function sample(p: Page): Promise<[number, number, boolean]> {
  return p.evaluate(() => {
    const v = document.querySelector("video.film") as HTMLVideoElement;
    const pl = (window as any).__msync?.player;
    return [performance.timeOrigin + performance.now(), pl ? pl.position() : v.currentTime, v.paused] as [number, number, boolean];
  });
}

/** Drift between the pages in ms, wall-clock corrected. Positive: guest ahead. */
async function driftMs(): Promise<number> {
  const [[th, ph], [tg, pg]] = await Promise.all([sample(hostPage), sample(guestPage)]);
  return (pg - (ph + (tg - th) / 1000)) * 1000;
}

async function joinRoom(p: Page, camera: boolean) {
  await p.goto(`/r/${code}`);
  if (!camera) {
    await p.getByLabel("Join the call with my camera").uncheck();
    await p.getByLabel("and my microphone").uncheck();
  }
  await p.getByRole("button", { name: "Join", exact: true }).click();
  await expect(p.locator(".bar-bottom")).toBeVisible();
}

async function bothPlaying() {
  for (const p of [hostPage, guestPage]) {
    await expect.poll(async () => (await sample(p))[2], { timeout: 30_000 }).toBe(false);
  }
}

test.beforeAll(async () => {
  const login = await fetch(`${BASE}/api/admin/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: PASSWORD }),
  });
  expect(login.ok).toBeTruthy();
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];

  const movieId = await ensureFilm();
  code = (await apiCall("/api/rooms", { method: "POST", body: JSON.stringify({ name: "e2e", movie_id: movieId }) })).code;

  const fakeMedia = ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"];
  hostBrowser = await chromium.launch({ args: fakeMedia });
  guestBrowser = GUEST === "webkit" ? await webkit.launch() : await chromium.launch({ args: fakeMedia });

  host = await hostBrowser.newContext({ ignoreHTTPSErrors: true, baseURL: BASE });
  const [name, value] = cookie.split("=");
  await host.addCookies([{ name, value, url: BASE }]);
  guest = await guestBrowser.newContext({ ignoreHTTPSErrors: true, baseURL: BASE, permissions: GUEST === "webkit" ? [] : ["camera", "microphone"] });

  // the guest knocks; the host admits from the API
  guestPage = await guest.newPage();
  await guestPage.goto(`/r/${code}`);
  await guestPage.getByLabel("Your name").fill("Meera");
  await guestPage.getByRole("button", { name: "Ask to join" }).click();
  await expect(guestPage.getByText("Waiting for your host")).toBeVisible();
  const rooms = await apiCall("/api/rooms");
  const knock = rooms.find((r: any) => r.code === code).knocks[0];
  await apiCall(`/api/rooms/${code}/guests/${knock.id}/admit`, { method: "POST" });

  hostPage = await host.newPage();
  await joinRoom(hostPage, true);
  await expect(guestPage.getByRole("button", { name: "Join", exact: true })).toBeVisible();
  await joinRoom(guestPage, GUEST !== "webkit");
});

test.afterAll(async () => {
  await hostBrowser?.close();
  await guestBrowser?.close();
  if (code) await apiCall(`/api/rooms/${code}`, { method: "DELETE" }).catch(() => {});
});

test("play starts both sides together and holds sync", async () => {
  await hostPage.getByRole("button", { name: "Play for both" }).click();
  await bothPlaying();
  await hostPage.waitForTimeout(3000); // let the first correction settle
  const xs: number[] = [];
  const end = Date.now() + DRIFT_SECONDS * 1000;
  while (Date.now() < end) {
    xs.push(Math.abs(await driftMs()));
    await hostPage.waitForTimeout(250);
  }
  xs.sort((a, b) => a - b);
  const p95 = xs[Math.floor(xs.length * 0.95)];
  console.log(`drift over ${DRIFT_SECONDS}s: median ${xs[Math.floor(xs.length / 2)].toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, max ${xs[xs.length - 1].toFixed(1)} ms`);
  expect(p95).toBeLessThan(80);
});

test("seek moves both, and they resume together", async () => {
  await hostPage.evaluate(() => (window as any).__msync.engine.seek(100));
  await bothPlaying();
  await expect.poll(async () => (await sample(guestPage))[1], { timeout: 20_000 }).toBeGreaterThan(99);
  await hostPage.waitForTimeout(2500);
  expect(Math.abs(await driftMs())).toBeLessThan(120);
});

test("a stalled guest pauses the host, then both resume together", async () => {
  // hold every segment the guest asks for, then push the guest past its buffer
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  const hold = async (route: Route) => {
    await held;
    await route.continue();
  };
  await guest.route(/\.m4s(\?|$)/, hold);
  await guestPage.evaluate(() => {
    const v = document.querySelector("video.film") as HTMLVideoElement;
    v.currentTime = Math.min(v.duration - 5, v.currentTime + 60);
  });
  // the host must pause within ~1.5 s of the guest stalling
  await expect.poll(async () => (await sample(hostPage))[2], { timeout: 5_000 }).toBe(true);
  await expect(hostPage.getByText(/catches up|Getting both of you ready/)).toBeVisible();
  release();
  await guest.unroute(/\.m4s(\?|$)/, hold);
  await bothPlaying();
  await hostPage.waitForTimeout(2500);
  expect(Math.abs(await driftMs())).toBeLessThan(120);
});

test("a dropped socket reconnects without disturbing playback", async () => {
  const before = (await sample(hostPage))[1];
  await guestPage.evaluate(() => (window as any).__msync.socket.drop());
  await expect.poll(() => guestPage.evaluate(() => (window as any).__msync.socket.status), { timeout: 10_000 }).toBe("open");
  await hostPage.waitForTimeout(2000);
  const [, after, paused] = await sample(hostPage);
  expect(paused).toBe(false);
  expect(after).toBeGreaterThan(before + 1);
  expect(Math.abs(await driftMs())).toBeLessThan(120);
});

test("rapid keyboard seeks settle on one barrier, no oscillation", async () => {
  await hostPage.locator(".hit").hover();
  for (let i = 0; i < 6; i++) await hostPage.keyboard.press("ArrowRight");
  await bothPlaying();
  await hostPage.waitForTimeout(3000);
  const seq = await hostPage.evaluate(() => (window as any).__msync.engine.seq);
  await hostPage.waitForTimeout(3000);
  expect(await hostPage.evaluate(() => (window as any).__msync.engine.seq)).toBe(seq);
  expect(Math.abs(await driftMs())).toBeLessThan(120);
});

test("pause stops both at the same frame", async () => {
  await guestPage.getByRole("button", { name: "Pause for both" }).click();
  await expect.poll(async () => (await sample(hostPage))[2]).toBe(true);
  await expect.poll(async () => (await sample(guestPage))[2]).toBe(true);
  await hostPage.waitForTimeout(800);
  const [[, ph], [, pg]] = await Promise.all([sample(hostPage), sample(guestPage)]);
  expect(Math.abs(ph - pg)).toBeLessThan(0.1);
});

test("chat reaches the other side", async () => {
  await guestPage.getByRole("button", { name: "Open chat" }).click();
  await guestPage.getByPlaceholder("Say something").fill("popcorn ready");
  await guestPage.keyboard.press("Enter");
  await expect(hostPage.locator(".toast", { hasText: "popcorn ready" })).toBeVisible();
});

test("the call connects with video both ways", async () => {
  test.skip(GUEST === "webkit", "WebKit has no fake camera in headless runs");
  for (const p of [hostPage, guestPage]) {
    await expect.poll(() => p.evaluate(() => {
      const v = document.querySelector(".tile:not(.self) video") as HTMLVideoElement | null;
      return v ? v.videoWidth : 0;
    }), { timeout: 30_000 }).toBeGreaterThan(0);
  }
});
