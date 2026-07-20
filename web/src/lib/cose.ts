// TS implementation of the pinned "ekenv-v1" envelope
// (ephemerkey/firmware/ephemerkey-envelope is the Rust reference; the
// scripts/smoke.mjs device simulator is a third, independent copy).
// The console uses this to sign configs with the owner key and seal them
// to each device's X25519 key; servers/couriers only ever relay the result.

import { ed25519, x25519 } from "@noble/curves/ed25519";
import { gcm } from "@noble/ciphers/aes.js";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils";

export const HDR_ALG = 1;
export const HDR_KID = 4;
export const HDR_IV = 5;
export const HDR_SEQ = -65537;
export const HDR_EPH = -65538;
export const ALG_EDDSA = -8;
export const ALG_A128GCM = 1;

// --- minimal CBOR ---------------------------------------------------------

function head(major: number, value: number): Uint8Array {
  const m = major << 5;
  if (value < 24) return Uint8Array.of(m | value);
  if (value <= 0xff) return Uint8Array.of(m | 24, value);
  if (value <= 0xffff) return Uint8Array.of(m | 25, value >> 8, value & 0xff);
  const b = new Uint8Array(5);
  b[0] = m | 26;
  new DataView(b.buffer).setUint32(1, value);
  return b;
}
export const cUint = (v: number) => head(0, v);
export const cInt = (v: number) => (v >= 0 ? head(0, v) : head(1, -1 - v));
export const cBstr = (b: Uint8Array) => concatBytes(head(2, b.length), b);
export const cTstr = (s: string) => {
  const b = utf8ToBytes(s);
  return concatBytes(head(3, b.length), b);
};
export const cArr = (...items: Uint8Array[]) => concatBytes(head(4, items.length), ...items);
export const cMap = (...pairs: Uint8Array[]) => concatBytes(head(5, pairs.length / 2), ...pairs);

/** Streaming decoder over a byte slice; throws on malformed input. */
export class Dec {
  private pos = 0;
  constructor(private buf: Uint8Array) {}

  private byte(): number {
    if (this.pos >= this.buf.length) throw new Error("cbor: truncated");
    return this.buf[this.pos++];
  }

  private take(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) throw new Error("cbor: truncated");
    const s = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    return s;
  }

  private head(): [number, number] {
    const b = this.byte();
    const major = b >> 5;
    const info = b & 0x1f;
    let value: number;
    if (info < 24) value = info;
    else if (info === 24) value = this.byte();
    else if (info === 25) value = (this.byte() << 8) | this.byte();
    else if (info === 26) {
      value = new DataView(this.take(4).buffer).getUint32(0);
    } else if (info === 27) {
      const hi = new DataView(this.take(8).buffer);
      value = hi.getUint32(0) * 2 ** 32 + hi.getUint32(4);
    } else throw new Error("cbor: unsupported");
    return [major, value];
  }

  uint(): number {
    const [m, v] = this.head();
    if (m !== 0) throw new Error("cbor: expected uint");
    return v;
  }

  int(): number {
    const [m, v] = this.head();
    if (m === 0) return v;
    if (m === 1) return -1 - v;
    throw new Error("cbor: expected int");
  }

  bstr(): Uint8Array {
    const [m, v] = this.head();
    if (m !== 2) throw new Error("cbor: expected bstr");
    return this.take(v);
  }

  tstr(): string {
    const [m, v] = this.head();
    if (m !== 3) throw new Error("cbor: expected tstr");
    return new TextDecoder().decode(this.take(v));
  }

  array(): number {
    const [m, v] = this.head();
    if (m !== 4) throw new Error("cbor: expected array");
    return v;
  }

  map(): number {
    const [m, v] = this.head();
    if (m !== 5) throw new Error("cbor: expected map");
    return v;
  }

  skip(depth = 8): void {
    if (depth === 0) throw new Error("cbor: too deep");
    const [m, v] = this.head();
    if (m === 2 || m === 3) this.take(v);
    else if (m === 4) for (let i = 0; i < v; i++) this.skip(depth - 1);
    else if (m === 5) for (let i = 0; i < 2 * v; i++) this.skip(depth - 1);
    else if (m === 6) this.skip(depth - 1);
    // 0/1/7: value already consumed by head()
  }
}

// --- device config (integer-keyed CBOR) -----------------------------------
// The sealed inner payload, in the pinned integer-keyed schema the firmware
// and emulator decode (ephemerkey-config): top level 1=role, 2=staleness_s,
// 3=zones [[lat_e7,lon_e7,radius_m]], 4=keys, 5=slots, 6=calendars, 7=confirm,
// 8=crit, 9=unlock_window_s (cascade reveal window). Every policy sub-document
// (key/slot/policy/gates/display/chain/confirm/calendar) is itself
// integer-keyed — see ephemerkey-config's schema doc. `action` is 0 unlock/
// 1 lock/2 duress, `mode` 0 sequence/1 time/2 both everywhere. A key's field 7
// (gated) marks a cascade reveal key; setting it auto-adds crit:["cascade"].

const E7 = 10_000_000;
const ACTION: Record<string, number> = { unlock: 0, lock: 1, duress: 2 };
const RMODE: Record<string, number> = { sequence: 0, time: 1, both: 2 };

const cBool = (b: boolean): Uint8Array => Uint8Array.of(b ? 0xf5 : 0xf4);
const secretB = (s: string): Uint8Array => cBstr(utf8ToBytes(s));

/** A CBOR map from integer keys, dropping entries whose value is undefined. */
function imap(entries: Array<[number, Uint8Array | undefined]>): Uint8Array {
  const flat: Uint8Array[] = [];
  for (const [k, v] of entries) if (v !== undefined) flat.push(cUint(k), v);
  return cMap(...flat);
}

const zoneCbor = (z: { lat: number; lon: number; radius_m: number }): Uint8Array =>
  cArr(cInt(Math.round(z.lat * E7)), cInt(Math.round(z.lon * E7)), cUint(z.radius_m));

const displayCbor = (d: any): Uint8Array =>
  imap([
    [1, cUint(d.mode === "scatter" ? 1 : 0)],
    [2, cUint(d.dwell_ms ?? 800)],
    [3, cUint(d.reveal_s ?? 5)],
    [4, cUint(d.once === "refuse" ? 1 : d.once === "decoy" ? 2 : 0)],
    [5, cUint(d.gap_min_s ?? 0)],
  ]);

const chainCbor = (c: any): Uint8Array =>
  imap([
    [1, secretB(c.secret)],
    [2, cUint(c.digits ?? 6)],
    [3, cUint(RMODE[c.mode] ?? 0)],
    [4, cUint(ACTION[c.action] ?? 1)], // default: lock
    [5, cUint(c.min_elapsed_s ?? 0)],
    [6, cUint(c.max_age_s ?? 3600)],
  ]);

const keyCbor = (k: any): Uint8Array =>
  imap([
    [1, secretB(k.secret)],
    [2, cUint(k.digits ?? 6)],
    [3, k.decoy !== undefined ? cUint(k.decoy) : undefined],
    [4, k.display ? displayCbor(k.display) : undefined],
    [5, k.chain ? chainCbor(k.chain) : undefined],
    [7, k.gated ? cBool(true) : undefined], // cascade: ritual-gated reveal key
  ]);

// The policy `type` (key 1) MUST come first — the decoder dispatches on it.
function policyCbor(p: any): Uint8Array {
  switch (p.type) {
    case "sequence":
      return imap([
        [1, cUint(1)],
        [2, cUint(p.n)],
        [3, cUint(p.window_s)],
        [4, cUint(p.gap_min_s)],
        [5, cUint(p.gap_max_s)],
        [6, cUint(p.delay_min_s)],
        [7, cUint(p.delay_max_s)],
        [8, cUint(p.jitter_s ?? 0)],
      ]);
    case "path":
      return imap([
        [1, cUint(2)],
        [2, cArr(...p.leg_keys.map((k: number) => cUint(k)))],
        [3, cUint(p.leg_deadline_s)],
        [4, cUint(p.delay_max_s)],
      ]);
    case "deadman":
      return imap([
        [1, cUint(3)],
        [2, cUint(p.beat_s)],
      ]);
    case "quorum":
      return imap([
        [1, cUint(4)],
        [2, cUint(p.m)],
        [3, cArr(...p.keys.map((k: number) => cUint(k)))],
        [4, cUint(p.window_s)],
        [5, cBool(!!p.alternating)],
        [6, cUint(p.gap_min_s)],
        [7, cUint(p.gap_max_s)],
      ]);
    default:
      return imap([[1, cUint(0)]]); // always
  }
}

const gatesCbor = (g: any): Uint8Array =>
  imap([
    [1, g.fence !== undefined ? cUint(g.fence) : undefined],
    [2, cUint(g.stillness_s ?? 0)],
    [3, g.calendar !== undefined ? cUint(g.calendar) : undefined],
  ]);

function negativeCbor(neg: string): Uint8Array {
  if (neg === "silent") return cArr(cUint(1));
  const m = /^lockout:(\d+)$/.exec(neg ?? "");
  if (m) return cArr(cUint(2), cUint(parseInt(m[1], 10)));
  return cArr(cUint(0)); // reset
}

const slotCbor = (s: any): Uint8Array =>
  imap([
    [1, cUint(s.key)],
    [2, cUint(ACTION[s.action] ?? 0)],
    [3, policyCbor(s.policy)],
    [4, cBool(!!s.progress)],
    [5, cBool(s.reset_on_invalid !== false)],
    [6, negativeCbor(s.negative ?? "reset")],
    [7, gatesCbor(s.gates ?? { stillness_s: 0 })],
    [8, cUint(s.veto_delay_s ?? 0)],
    [9, s.veto_key !== undefined ? cUint(s.veto_key) : undefined],
    [10, cUint(s.budget ?? 0)],
  ]);

const confirmCbor = (c: any): Uint8Array =>
  imap([
    [1, secretB(c.secret)],
    [2, cUint(c.digits ?? 6)],
    [3, cUint(RMODE[c.mode] ?? 0)],
  ]);

// days[] (0=Sun..6=Sat) → bitmask; "HH:MM" → minutes from midnight.
const daysMask = (days: number[]): number => (days ?? []).reduce((m, d) => m | (1 << d), 0);
const hhmm = (s: string): number => {
  const [h, m] = (s ?? "0:0").split(":").map((x) => parseInt(x, 10) || 0);
  return h * 60 + m;
};
const calendarCbor = (c: any): Uint8Array =>
  imap([
    [1, cUint(daysMask(c.days))],
    [2, cUint(hhmm(c.start))],
    [3, cUint(hhmm(c.end))],
  ]);

/** Encode a (flattened) device config as the pinned integer-keyed CBOR the
 *  firmware parses. `cfg` is the editor's config object plus an optional
 *  `crit` array; degrees-based zone centres are converted to 1e7 fixed point. */
export function configToCbor(cfg: any): Uint8Array {
  const pairs: Uint8Array[] = [];
  const put = (k: number, v: Uint8Array) => pairs.push(cUint(k), v);
  // A ritual-gated key MUST ship crit:["cascade"] so a firmware that can't
  // enforce the ritual refuses the config instead of revealing real codes
  // ungated. Inject it here rather than trusting the caller to remember.
  const crit = new Set<string>(cfg.crit ?? []);
  if (cfg.keys?.some((k: any) => k.gated)) crit.add("cascade");
  put(1, cUint(cfg.role));
  if (typeof cfg.staleness_s === "number") put(2, cUint(cfg.staleness_s));
  if (cfg.zones?.length) put(3, cArr(...cfg.zones.map(zoneCbor)));
  if (cfg.keys?.length) put(4, cArr(...cfg.keys.map(keyCbor)));
  if (cfg.slots?.length) put(5, cArr(...cfg.slots.map(slotCbor)));
  if (cfg.calendars?.length) put(6, cArr(...cfg.calendars.map(calendarCbor)));
  if (cfg.confirm) put(7, confirmCbor(cfg.confirm));
  if (crit.size) put(8, cArr(...[...crit].map((c) => cTstr(c))));
  if (typeof cfg.unlock_window_s === "number") put(9, cUint(cfg.unlock_window_s));
  return cMap(...pairs);
}

// --- COSE_Sign1 -----------------------------------------------------------

const SIGN1_PROTECTED = Uint8Array.of(0xa1, 0x01, 0x27); // {1: -8 EdDSA}

export function sign1(payload: Uint8Array, kid: Uint8Array | null, priv: Uint8Array): Uint8Array {
  const sigStruct = cArr(
    cTstr("Signature1"),
    cBstr(SIGN1_PROTECTED),
    cBstr(new Uint8Array()),
    cBstr(payload),
  );
  const sig = ed25519.sign(sigStruct, priv);
  const unprot = kid ? cMap(cInt(HDR_KID), cBstr(kid)) : cMap();
  return cArr(cBstr(SIGN1_PROTECTED), unprot, cBstr(payload), cBstr(sig));
}

export interface Sign1Parts {
  protected: Uint8Array;
  kid: Uint8Array | null;
  payload: Uint8Array;
  sig: Uint8Array;
}

export function sign1Parse(blob: Uint8Array): Sign1Parts {
  const d = new Dec(blob);
  if (d.array() !== 4) throw new Error("cose: not a Sign1");
  const prot = d.bstr();
  let kid: Uint8Array | null = null;
  const n = d.map();
  for (let i = 0; i < n; i++) {
    if (d.int() === HDR_KID) kid = d.bstr();
    else d.skip();
  }
  return { protected: prot, kid, payload: d.bstr(), sig: d.bstr() };
}

/** Verify and return the payload; throws on bad signature/alg. */
export function sign1Verify(blob: Uint8Array, pub: Uint8Array): Uint8Array {
  const parts = sign1Parse(blob);
  const p = new Dec(parts.protected);
  let algOk = false;
  const n = p.map();
  for (let i = 0; i < n; i++) {
    if (p.int() === HDR_ALG) algOk = p.int() === ALG_EDDSA;
    else p.skip();
  }
  if (!algOk) throw new Error("cose: wrong algorithm");
  const sigStruct = cArr(
    cTstr("Signature1"),
    cBstr(parts.protected),
    cBstr(new Uint8Array()),
    cBstr(parts.payload),
  );
  if (!ed25519.verify(parts.sig, sigStruct, pub)) throw new Error("cose: bad signature");
  return parts.payload;
}

// --- COSE_Encrypt0 (seal / peek) ------------------------------------------

export function seal(
  plaintext: Uint8Array,
  kxPub: Uint8Array,
  seq: number,
  target: Uint8Array,
): Uint8Array {
  const ephPriv = crypto.getRandomValues(new Uint8Array(32));
  const ephPub = x25519.getPublicKey(ephPriv);
  const shared = x25519.getSharedSecret(ephPriv, kxPub);
  const key = hkdf(sha256, shared, ephPub, utf8ToBytes("ekenv-v1"), 16);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const prot = cMap(
    cInt(HDR_ALG),
    cInt(ALG_A128GCM),
    cInt(HDR_KID),
    cBstr(target),
    cInt(HDR_SEQ),
    cUint(seq),
  );
  const aad = cArr(cTstr("Encrypt0"), cBstr(prot), cBstr(new Uint8Array()));
  const ct = gcm(key, iv, aad).encrypt(plaintext); // ciphertext ‖ tag16
  const unprot = cMap(cInt(HDR_IV), cBstr(iv), cInt(HDR_EPH), cBstr(ephPub));
  return cArr(cBstr(prot), unprot, cBstr(ct));
}

/** Routing headers without decryption (only trustworthy to the device). */
export function peek(blob: Uint8Array): { seq: number; target: Uint8Array } {
  const d = new Dec(blob);
  if (d.array() !== 3) throw new Error("cose: not an Encrypt0");
  const p = new Dec(d.bstr());
  const n = p.map();
  let seq: number | null = null;
  let target: Uint8Array | null = null;
  for (let i = 0; i < n; i++) {
    const label = p.int();
    if (label === HDR_SEQ) seq = p.uint();
    else if (label === HDR_KID) target = p.bstr();
    else p.skip();
  }
  if (seq === null || target === null) throw new Error("cose: missing headers");
  return { seq, target };
}

// --- enrollment doc (serial IDENTITY frame) -------------------------------

export interface Enrollment {
  deviceId: Uint8Array;
  signPub: Uint8Array;
  kxPub: Uint8Array;
  fw: string;
}

/** Parse + self-verify an IDENTITY payload: Sign1({1:id,2:sign,3:kx,4:fw}). */
export function parseEnrollment(blob: Uint8Array): Enrollment {
  const parts = sign1Parse(blob);
  const d = new Dec(parts.payload);
  const n = d.map();
  let deviceId: Uint8Array | null = null;
  let signPub: Uint8Array | null = null;
  let kxPub: Uint8Array | null = null;
  let fw = "";
  for (let i = 0; i < n; i++) {
    switch (d.uint()) {
      case 1:
        deviceId = d.bstr();
        break;
      case 2:
        signPub = d.bstr();
        break;
      case 3:
        kxPub = d.bstr();
        break;
      case 4:
        fw = d.tstr();
        break;
      default:
        d.skip();
    }
  }
  if (!deviceId || !signPub || !kxPub) throw new Error("enrollment: missing fields");
  sign1Verify(blob, signPub); // self-signed: proves possession of sign key
  return { deviceId, signPub, kxPub, fw };
}
