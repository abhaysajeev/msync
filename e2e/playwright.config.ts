import { defineConfig } from "@playwright/test";

// Runs against a live stack (docker compose up). BASE_URL defaults to the local Caddy.
export default defineConfig({
  testDir: "./tests",
  timeout: 10 * 60_000,
  expect: { timeout: 20_000 },
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.BASE_URL ?? "https://localhost",
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
  },
});
