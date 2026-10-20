import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

// Dev: the FastAPI app runs on :8000. changeOrigin stays false so the WebSocket Origin
// check (Origin host must equal Host) passes through the proxy.
const api = "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [preact()],
  server: {
    host: true,
    proxy: {
      "/api": { target: api },
      "/media": { target: api },
      "/ws": { target: api, ws: true },
      "/files": { target: "http://127.0.0.1:8080" },
    },
  },
  build: { target: "safari15", sourcemap: true },
});
