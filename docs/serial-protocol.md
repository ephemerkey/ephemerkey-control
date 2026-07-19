# ephemerkey serial protocol (draft v1)

Framed request/response protocol between a host (browser WebSerial or the
ESP32-C3 bridge) and an ephemerkey device on its USB-CDC provisioning
interface. The device only trusts the COSE layers carried inside frames —
the framing itself is plumbing, not security.

Status: **draft**. To be implemented first in `ephemerkey-emu` (as a pty/stdio
transport), then in firmware `ephemerkey-rs/src/provision.rs`. Mirror
implementation lives in `web/src/lib/serial.ts`.

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
| 0x40 | h→d | WIFI_SET      | CBOR `{ssid tstr, psk tstr}` — stored by the ESP32-C3; empty ssid clears. Provisioning-gated, plaintext by design (see DESIGN.md "WiFi provisioning") |
| 0x41 | h→d | WIFI_STATUS_REQ | empty |
| 0x42 | d→h | WIFI_STATUS   | CBOR `{connected bool, ssid tstr, rssi int, ip tstr}` |
| 0x7E | d→h | OK            | generic ack (begin/chunk accepted) |
| 0x7F | d→h | ERROR         | `{code u8}`: 1 bad-state, 2 bad-sig, 3 seq-rollback, 4 wrong-set, 5 storage, 6 crc |

Enrollment write-back (`owner_pub` TOFU) happens via the same CONFIG path:
the first sealed doc a factory-fresh device accepts carries the owner binding
(first writer wins, provisioning-mode gated — see upstream
`DESIGN-management.md` §Enrollment).

## Notes

- USB-CDC ignores baud; the emulator stdio/pty transport uses the same bytes.
- The courier page never interprets CONFIG payloads — it streams what the
  backend (or a local `.ekcfg` file) hands it.
- The Improv-WiFi serial SDK (`repos/sdk-serial-js`) is the pattern reference
  for the host-side scanner/RPC loop; we may additionally speak actual Improv
  to the ESP32 for WiFi credential onboarding, which is orthogonal to this
  protocol.
