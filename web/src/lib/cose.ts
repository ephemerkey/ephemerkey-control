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
// The sealed inner payload. Its TOP-LEVEL keys are the pinned contract the
// firmware parses (ephemerkey-envelope::config): 1=role, 2=staleness_s,
// 3=zones [[lat_e7,lon_e7,radius_m]], 8=crit [tstr]. Keys 4-7 carry the
// policy sub-documents (keys/slots/calendars/confirm) as self-describing
// CBOR — the firmware skips them today (it can't act on them yet), a future
// policy parser reads them, and the emulator reads only `crit` (key 8).

const E7 = 10_000_000;

/** Generic CBOR for a JSON-ish value used by the not-yet-parsed policy
 *  sub-documents: their inner fields keep their source-doc names. Throws on a
 *  non-integer number — the config schema has none (coords go through zones). */
export function cValue(v: unknown): Uint8Array {
  if (typeof v === "boolean") return Uint8Array.of(v ? 0xf5 : 0xf4);
  if (v === null || v === undefined) return Uint8Array.of(0xf6);
  if (typeof v === "number") {
    if (!Number.isInteger(v)) throw new Error(`cbor: non-integer ${v}`);
    return cInt(v);
  }
  if (typeof v === "string") return cTstr(v);
  if (Array.isArray(v)) return cArr(...v.map(cValue));
  if (typeof v === "object") {
    const pairs: Uint8Array[] = [];
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val === undefined) continue;
      pairs.push(cTstr(k), cValue(val));
    }
    return cMap(...pairs);
  }
  throw new Error(`cbor: unsupported ${typeof v}`);
}

const zoneCbor = (z: { lat: number; lon: number; radius_m: number }): Uint8Array =>
  cArr(cInt(Math.round(z.lat * E7)), cInt(Math.round(z.lon * E7)), cUint(z.radius_m));

/** Encode a (flattened) device config as the pinned integer-keyed CBOR the
 *  firmware parses. `cfg` is the editor's config object plus an optional
 *  `crit` array; degrees-based zone centres are converted to 1e7 fixed point. */
export function configToCbor(cfg: any): Uint8Array {
  const pairs: Uint8Array[] = [];
  const put = (k: number, v: Uint8Array) => pairs.push(cUint(k), v);
  put(1, cUint(cfg.role));
  if (typeof cfg.staleness_s === "number") put(2, cUint(cfg.staleness_s));
  if (cfg.zones?.length) put(3, cArr(...cfg.zones.map(zoneCbor)));
  if (cfg.keys?.length) put(4, cValue(cfg.keys));
  if (cfg.slots?.length) put(5, cValue(cfg.slots));
  if (cfg.calendars?.length) put(6, cValue(cfg.calendars));
  if (cfg.confirm) put(7, cValue(cfg.confirm));
  if (cfg.crit?.length) put(8, cArr(...cfg.crit.map((c: string) => cTstr(c))));
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
