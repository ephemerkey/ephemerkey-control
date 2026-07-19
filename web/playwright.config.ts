import { defineConfig } from "@playwright/test";

// E2e harness: real backend (fresh SQLite under ../target), real vite dev
// server, real browser crypto. WebSerial device flows are exercised
// separately against the emulator (future) — these tests cover the
// key-custody, registration, and recovery loops.
export default defineConfig({
  testDir: "tests",
  timeout: 60_000,
  fullyParallel: false,
  use: {
    baseURL: "http://127.0.0.1:5173",
  },
  webServer: [
    {
      command:
        "bash -c 'cd .. && cargo build -p ekctl-server && rm -f target/e2e.db* && EKCTL_DB=target/e2e.db EKCTL_LISTEN=127.0.0.1:8321 RUST_LOG=warn ./target/debug/ekctl-server'",
      url: "http://127.0.0.1:8321/api/health",
      reuseExistingServer: false,
      timeout: 180_000,
    },
    {
      command: "npm run dev -- --host 127.0.0.1 --port 5173 --strictPort",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
