# ephemerkey-control

Control plane for [ephemerkey](https://github.com/ephemerkey/ephemerkey)
devices: a manager console + public courier page (React, WebSerial, all
crypto in-browser) and an optional zero-knowledge backend (Rust/axum +
SQLite) that stores sealed config blobs, serves the ESP32 self-update
endpoint, and records signed lock/unlock telemetry.

Read `DESIGN.md` first — especially the trust model: **no accounts; the
set's owner Ed25519 key is the only management credential**, configs are
sealed end-to-end to each device, and couriers/servers handle only opaque
blobs.

## Layout

- `server/` — `ekctl-server` (axum, SQLite via sqlx, capability-auth `EK1`).
  Depends on `../ephemerkey/firmware/ephemerkey-core` (path) for shared
  validation logic — keep both repos checked out side by side.
- `web/` — Vite + React + TS SPA: manager console (`/`) and courier push
  page (`/push`).
- `docs/serial-protocol.md` — the framed WebSerial/USB-CDC contract (draft;
  to be implemented in `ephemerkey-emu`, then firmware).

## Develop

```sh
# backend (http://127.0.0.1:8321, creates ekctl.db)
cargo run -p ekctl-server

# frontend dev server (proxies /api to the backend)
cd web && npm install && npm run dev
```

Production: `npm run build`, then run the server with
`EKCTL_WEB_DIST=web/dist` (it serves the SPA itself). Env: `EKCTL_DB`,
`EKCTL_LISTEN`, `EKCTL_WEB_DIST`.

## Status

Scaffold. Working: set registration + roster/config/event storage behind
owner-key signed auth (path-bound GETs, single-use nonces), courier blob
relay, ESP32 config polling, config push history (audit/re-download), the
per-set recovery blob store (`source` sealed to the owner key, `keywrap`
passphrase-wrapped keyfile — see DESIGN.md "Recovery" and "Owner-key
custody"), the recovery crypto itself (Argon2id keywrap + ECIES source
sealing in `web/src/lib/backup.ts`), and the console flows for both.
Tests: `node scripts/smoke.mjs` (API, port 8399) and `npm run test:e2e`
in `web/` (Playwright; spins up backend + vite itself, covers key
custody, registration, and both recovery loops end-to-end). Pending the firmware envelope format
(tracked in `ephemerkey/DESIGN-management.md`): COSE sealing/verification,
config-ack + telemetry ingest, device challenge on the courier path, the
policy editor, and emulator-backed end-to-end tests.
