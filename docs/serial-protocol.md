# ephemerkey serial protocol (draft v1)

Framed request/response protocol between a host (browser WebSerial or the
ESP32-C3 bridge) and an ephemerkey device on its USB-CDC provisioning
interface. The device only trusts the COSE layers carried inside frames —
the framing itself is plumbing, not security.

Status: **implemented** in `ekemu serial` (ephemerkey repo — Rust
`ephemerkey-frame` + `ephemerkey-envelope`, over TCP for testing; run
`ekemu serial state.json [addr]`) and in `web/src/lib/serial.ts` /
`scripts/ekenv.mjs` on the host side. Firmware `provision.rs` is the
remaining implementation, reusing the same two crates over USB-CDC.
End-to-end exercise: `node scripts/serial-emu-e2e.mjs`.

## Framing

```
+------+------+------+----------+---------+----------+
| 'E'  | 'K'  | ver  | type     | len u16 | payload  | crc16 u16
+------+------+------+----------+---------+----------+
  0x45   0x4B   0x01   1 byte     LE        len bytes   LE
```

- `crc16`: CRC-16/CCITT-FALSE over `ver..payload` (not the magic).
- Max `len` 1024; larger objects (config blobs ≤ 2 KB, telemetry) are chunked
  at the command layer.
- Non-frame bytes on the wire (boot logs, etc.) are skipped by scanning for
  the magic; a corrupt CRC drops the frame silently and the host retries.
- One outstanding request at a time; every request type has a response type
  (or `ERROR`).

## Frame types

| type | dir | name          | payload |
|------|-----|---------------|---------|
| 0x01 | h→d | IDENTITY_REQ  | empty |
| 0x02 | d→h | IDENTITY      | CBOR enrollment doc `{device_id, sign_pub, kx_pub, fw, set_id?}` (self-signed COSE_Sign1) |
| 0x03 | h→d | CHALLENGE     | 32-byte nonce (server- or locally-generated) |
| 0x04 | d→h | CHALLENGE_SIG | Ed25519(device_sign, "ek-identify-v1" ‖ nonce) |
| 0x10 | h→d | CONFIG_BEGIN  | `{total_len u16, seq u32, crc32 u32}` |
| 0x11 | h→d | CONFIG_CHUNK  | `{offset u16}` ‖ bytes of the sealed COSE blob |
| 0x12 | h→d | CONFIG_COMMIT | empty — device verifies envelope, applies |
| 0x13 | d→h | CONFIG_ACK    | signed config-ack `{seq, config_hash}` (COSE_Sign1, forwarded verbatim to the backend) |
| 0x30 | h→d | EVENTS_REQ    | `{after_seq u32}` |
| 0x31 | d→h | EVENTS        | COSE_Sign1 event batch (chunk-flagged) |
| 0x40 | h→d | WIFI_SET      | CBOR `{1: ssid tstr, 2: psk tstr}` — stored by the ESP32-C3; empty ssid clears. Provisioning-gated, plaintext by design (see DESIGN.md "WiFi provisioning") |
| 0x41 | h→d | WIFI_STATUS_REQ | empty |
| 0x42 | d→h | WIFI_STATUS   | CBOR `{1: connected uint(0/1), 2: ssid tstr, 3: rssi int?, 4: ip tstr?}` |
| 0x7E | d→h | OK            | generic ack (begin/chunk accepted) |
| 0x7F | d→h | ERROR         | `{code u8}`: 1 bad-state, 2 bad-sig, 3 seq-rollback, 4 wrong-set, 5 storage, 6 crc |

Enrollment write-back (`owner_pub` TOFU) happens via the same CONFIG path:
**the inner COSE_Sign1 carries `owner_pub` as its `kid` (header 4)**. A
factory-fresh device verifies the signature against that key and adopts it
(first writer wins, provisioning-mode gated); a bound device rejects any
other owner with `ERROR wrong-set`. Physical re-provisioning is the only
way to re-key (emulator: delete the state file). See upstream
`DESIGN-management.md` §Enrollment.

## Notes

- USB-CDC ignores baud; the emulator stdio/pty transport uses the same bytes.
- The courier page never interprets CONFIG payloads — it streams what the
  backend (or a local `.ekcfg` file) hands it.
- The Improv-WiFi serial SDK (`repos/sdk-serial-js`) is the pattern reference
  for the host-side scanner/RPC loop; we may additionally speak actual Improv
  to the ESP32 for WiFi credential onboarding, which is orthogonal to this
  protocol.
