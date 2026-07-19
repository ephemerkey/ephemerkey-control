# ephemerkey-control — Design

Backend + frontend control plane for ephemerkey devices. Companion to the
hardware/firmware repo (`../ephemerkey`); the authoritative upstream spec is
`ephemerkey/DESIGN-management.md` (sets, keys, CBOR/COSE encoding, transports).
This repo implements that management plane as a deployable webapp.

## Trust model (the load-bearing decision)

**There are no user accounts.** The set's **owner Ed25519 key** is the sole
root of authority, exactly as the firmware already assumes:

- Devices are bound to a set at enrollment by storing `owner_pub`
  (`set_id = SHA-256(owner_pub)[0..8]`). They accept only configs whose inner
  `COSE_Sign1` verifies under that key, with strictly increasing `seq`.
- **Management = possession of the owner key.** The web console authenticates
  to the backend by signing server-issued nonces with the owner key. Sharing a
  pool with another manager = sharing the key. No logins, no password DB.
- **The backend is untrusted and zero-knowledge.** Config documents are
  authored, signed, and per-device encrypted (`COSE_Encrypt0` to the device's
  X25519 key) entirely in the manager's browser. The server stores and relays
  sealed blobs it cannot read or forge. Server compromise leaks metadata
  (roster, seq numbers, event stream), never key material or config contents.
- **Couriers are blind.** Anyone may open the public push page and program a
  device over WebSerial. They ferry an opaque blob; the only feedback is
  "device X is now at config seq N" via the device's signed `config-ack`.
- **The backend is optional.** Because authority lives in the key and
  confidentiality in the envelope, the same frontend must work backend-less:
  export a sealed `.ekcfg` blob (file/QR), sneakernet it to the courier page,
  pull signed telemetry back over WebSerial and verify it in-browser. The
  backend adds: durable storage, the ESP32 HTTP endpoint, event history, and
  multi-courier coordination. Frontend code treats it as a pluggable sync
  layer behind one small interface.

## Components

```
ephemerkey-control/
├── server/     Rust (axum + sqlx/SQLite) — capability-authed API, blob store,
│               telemetry ingest, ESP32 device endpoint, serves web/dist
├── web/        React + Vite + TS SPA — manager console, public courier page,
│               WebSerial transport, all crypto client-side
│               (@noble/curves ed25519/x25519, cbor-x for CBOR/COSE)
└── docs/       serial-protocol.md — framed WebSerial/USB-CDC contract
```

Server reuses `ephemerkey-core` (path dep on `../ephemerkey/firmware/
ephemerkey-core`) for confirm-TOTP receipt validation (`receipt::Validator`)
and, as it lands, shared config/COSE types. The emulator (`ephemerkey-emu`)
stands in for hardware while firmware transports are TODO.

## Data model (SQLite)

- `sets(set_id[8] PK, owner_pub[32] UNIQUE, name, created_at)`
- `devices(device_id PK, set_id FK, sign_pub, kx_pub, role, name, fw,
   enrolled_at, last_seen_at, acked_seq)` — added by pasting the device's
   signed enrollment doc `{device_id, sign_pub, kx_pub, fw}` ("binding key
   information") captured during button-gated provisioning.
- `config_blobs(id PK, set_id, device_id, seq, blob, created_at, acked_at,
   UNIQUE(device_id, seq))` — `blob` is the sealed COSE envelope, opaque.
   `seq` and target device id are mirrored in plaintext columns (and must
   match the COSE headers) so the server can enforce monotonicity without
   decrypting.
- `events(id PK, device_id, seq, rtc_ts, type, detail, chain_tag,
   received_at, transport, UNIQUE(device_id, seq))` — unlock/lock/duress/
   tamper/fence/power/config-ack, from `COSE_Sign1(events, device_key)`
   batches, signature verified against `devices.sign_pub` before insert.
- `challenges(nonce PK, purpose, created_at)` — single-use, short TTL.

## API surface

Auth scheme `EK1`: obtain `POST /api/challenge` → `{nonce}`; send
`Authorization: EK1 <nonce>:<sig>` where `sig = Ed25519(owner_priv,
context || nonce || SHA-256(body))` (`context` is a fixed domain-separation
string per endpoint class; path is included for GETs).

`Authorization: EK1 <nonce>:<sig>` where `sig = Ed25519(owner_priv,
context || nonce || SHA-256(payload))`; `payload` is the request body for
POSTs and the **full request path** for GETs (binding each signature to the
exact resource).

Manager (owner-key signed):
- `POST /api/sets` — register `{owner_pub, name}`; sig proves key possession;
  server derives `set_id`.
- `GET  /api/sets/{set_id}` — roster: devices, last-seen, acked vs pending seq.
- `POST /api/sets/{set_id}/devices` — add enrollment doc.
- `POST /api/sets/{set_id}/configs` — upload sealed blob for a device
  (`seq` must exceed stored + acked).
- `GET  /api/sets/{set_id}/configs` — history of pushed blobs (audit).
- `GET  /api/sets/{set_id}/configs/{device_id}/{seq}` — download a pushed
  blob (still device-sealed) for re-push / sneakernet export.
- `GET|POST /api/sets/{set_id}/blobs/source` — the recovery source blob
  (below).
- `POST /api/sets/{set_id}/blobs/keywrap` — the wrapped keyfile (GET is
  public, below).
- `GET  /api/sets/{set_id}/events` — verified event history.

Courier (public, unauthenticated — blobs are opaque by construction):
- `POST /api/courier/identify` — device's signed challenge response from the
  serial identity exchange → `{pending: bool, seq}`.
- `GET  /api/courier/config/{device_id}` — sealed blob for the pending seq.
- `POST /api/courier/ack` — device-signed `config-ack`; server verifies and
  records `acked_at`/`acked_seq`.

Device (ESP32-C3 over HTTPS, device-key signed):
- `GET  /api/device/{device_id}/config?after=N` — 200 sealed blob | 204;
  updates `last_seen_at`.
- `POST /api/device/{device_id}/events` — `COSE_Sign1` event batch; server
  verifies, stores, updates `last_seen_at`. This is also how "latest update
  happened at T" is recorded (config-ack events).

## Flows

**Enroll**: device in provisioning mode (button + USB) → console reads signed
enrollment doc over WebSerial → manager approves → `POST devices` → console
re-seals current config for the new device (client-side X25519) and uploads.

**Author + publish**: console edits config (slots/keys/zones/policies — same
shapes as `ephemerkey-emu/scenarios/*.json`) → Review & sign diff →
`COSE_Sign1` with owner key → `COSE_Encrypt0` per target device →
`POST configs` (and/or export `.ekcfg`).

**Blind push (WebSerial)**: courier page connects → serial identity exchange
(device signs a server or locally supplied nonce with its device key; X25519
available for session confidentiality) → `identify` → fetch sealed blob →
stream in chunks over serial → device verifies sign+seq inside its own trust
boundary → emits signed `config-ack` → `ack` → page shows "seq N delivered".

**Self-update (WiFi)**: ESP32 polls `config?after=<current>`, streams blob to
the STM32 over LPUART1, pushes event batches (including the ack) upstream.

## Recovery — the backend is the durable copy, the browser a cache

Pushed config blobs are sealed to each *device's* X25519 key, so they cannot
reconstruct the manager's editing state. Loss of browser state must not mean
loss of the pool, so on every "Review & sign" the console additionally:

1. Seals the full config source document (all devices' plaintext configs,
   names, zones, notes) to an **owner-derived X25519 key** —
   `kx = X25519 keypair from HKDF-SHA256(owner_seed, "ekctl-kx-v1")`. A
   separate HKDF-derived key (not the Ed25519↔X25519 birational map) keeps
   signing and encryption uses cleanly separated while still deriving
   everything from the single 32-byte seed.
2. Uploads it to `POST /api/sets/{set_id}/blobs/source` (≤ 256 KiB, upsert).

Recovery on a fresh browser = keyfile (or keywrap, below) + `GET blobs/
source` → decrypt → full console state. `GET /api/sets/{set_id}/configs`
additionally lists every blob actually pushed (seq, size, created/acked), so
"what is out there" is auditable and re-downloadable independent of local
state. Backend-less operation keeps working: the same sealed source doc can
be exported/imported as a file.

## Event visibility & code validation

Split along the trust boundary:

- **The backend verifies authenticity, not meaning.** It checks each event
  batch's `COSE_Sign1` against `devices.sign_pub`, enforces per-device seq
  monotonicity, and stores the `chain_tag` so excised history is detectable.
  It can do this because none of it needs secrets. The console's Events view
  reads `GET /api/sets/{set_id}/events` (unlock/lock/duress/tamper/fence/
  power/config-ack, per device, with last-update timestamps).
- **The console validates code-level semantics client-side**, because only
  the manager has the seeds (they live in the sealed source doc). Two
  validators, both runnable in-browser:
  - confirm-TOTP receipts: the same logic as
    `ephemerkey-core/src/receipt.rs::Validator` (HOTP sequence proof + TOTP
    time proof against `K_confirm`); port to TS or compile ephemerkey-core
    to WASM — the firmware crate is `no_std` and trivially wasm-able, which
    keeps one implementation of the truth.
  - event↔code cross-checks: recompute expected TOTP/HOTP values for the
    event's timestamp/counter from the source-doc seeds and compare against
    the truncated code hash recorded in the event detail.

**Seed export — a generator is not the only code source.** Any TOTP key in
the source doc can be exported from the console as a standard
`otpauth://totp/…?secret=<base32>&algorithm=SHA1&digits=N&period=30` URI +
QR, loadable into any authenticator app or another hardware token.
Constraints to surface in the UI: authenticator apps generally accept only
6–8 digits (ephemerkey supports 4–10); zone-keyed secrets export per-zone
(an exported `K_home` mints codes "as if in the home zone" — exporting it
deliberately bypasses the geofence, which is sometimes exactly the point,
e.g. a backup code source in a safe); every export widens the trust circle
and should be logged in the source doc's notes.

## WiFi provisioning (ESP32-C3)

Plain `{ssid, psk}` — deliberately *not* part of the owner-sealed config
document's secrets model (the person standing at the device typing their own
WiFi password is allowed to know it). Two paths:

- **Local (provisioning mode)**: `WIFI_SET` frame over the serial protocol
  (console or courier page form → device stores it; `WIFI_STATUS` for
  connect/RSSI/IP feedback). Button-gated like all provisioning writes.
- **Sealed (fleet/offline)**: an optional `wifi: {ssid, psk}` entry in the
  config document's device-opts map, for re-provisioning remote fleets
  through the normal sealed-blob path — couriers still can't read it.

The ESP32 also natively speaks Improv-WiFi over its own USB; we keep that
as a recovery/bring-up fallback but the primary path is the STM32-mediated
frame above, so one cable and one protocol cover everything.

## Owner-key custody & backup

Everything derives from one 32-byte Ed25519 seed (sign key, `set_id`, the
HKDF'd recovery kx key), so backing up the seed backs up the whole pool.
Losing it is unrecoverable by design — upstream spec: no server reset,
physical re-enrollment of every device. Custody tiers:

1. **Keyfile JSON** (implemented) — canonical interchange: export from the
   console, store in a password manager, send to co-managers (sharing the
   file *is* sharing management). Theft = full control until devices are
   physically re-keyed; treat it like the physical keys to the locks.
2. **Passphrase-wrapped keyfile on the backend** (planned) — seed encrypted
   client-side with Argon2id → XChaCha20-Poly1305 (`@noble/hashes` /
   `@noble/ciphers`), stored at `blobs/keywrap`. Bootstrap on any browser =
   set_id + passphrase. GET is deliberately unauthenticated (the fresh
   browser has no key yet); the tradeoff is offline guessing by anyone who
   learns the set_id, mitigated by aggressive Argon2id parameters and UI
   enforcement of a strong passphrase. Managers who dislike the tradeoff
   simply don't store a keywrap.
3. **Paper cold backup** (planned) — seed as a BIP39-style 24-word mnemonic
   and/or QR in the keyfile export dialog; print and store offline.
4. **Later**: Shamir m-of-n seed shards for co-manager pools (matches the
   project's quorum ethos); WebAuthn/passkey-PRF wrapping for daily-driver
   browsers; owner-key rotation doc (signed by old key) per upstream design.

## Open items / later milestones

- Pin the canonical integer-keyed CBOR config doc + COSE envelope jointly with
  firmware (tracked in `ephemerkey/DESIGN-management.md`); until then the
  console edits emulator-JSON shapes and the envelope code is isolated in
  `web/src/lib/`.
- Serial protocol below is a draft contract to be implemented in
  `ephemerkey-emu` first, then firmware (`provision.rs`).
- Key UX: owner key currently stored extractable (export/import JSON); later
  optional WebAuthn/passkey-wrapped or hardware-token signing.
- Delegation (multiple distinct manager keys per set via signed delegation
  docs) — deliberately out of scope for v1; share the key.
- OTA firmware staging via the same blob-relay pattern.
