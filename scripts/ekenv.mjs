// Shared test-side implementation of ekenv-v1 (CBOR/COSE) + the serial
// framing + EK1 API client. Deliberately independent of web/src/lib — the
// scripts act as "the other implementation" when talking to Rust code.
import { ed25519, x25519 } from "../web/node_modules/@noble/curves/ed25519.js";
import { sha256 } from "../web/node_modules/@noble/hashes/sha2.js";
import { hkdf } from "../web/node_modules/@noble/hashes/hkdf.js";
import { gcm } from "../web/node_modules/@noble/ciphers/aes.js";
import { bytesToHex, hexToBytes, utf8ToBytes, concatBytes } from "../web/node_modules/@noble/hashes/utils.js";

export { ed25519, x25519, sha256, hkdf, gcm, bytesToHex, hexToBytes, utf8ToBytes, concatBytes };

// --- CBOR ------------------------------------------------------------------

export function cborHead(major, value) {
  const m = major << 5;
  if (value < 24) return Uint8Array.of(m | value);
  if (value <= 0xff) return Uint8Array.of(m | 24, value);
  if (value <= 0xffff) return Uint8Array.of(m | 25, value >> 8, value & 0xff);
  const b = new Uint8Array(5);
  b[0] = m | 26;
  new DataView(b.buffer).setUint32(1, value);
  return b;
}
export const cUint = (v) => cborHead(0, v);
export const cInt = (v) => (v >= 0 ? cborHead(0, v) : cborHead(1, -1 - v));
export const cBstr = (b) => concatBytes(cborHead(2, b.length), b);
export const cTstr = (s) => concatBytes(cborHead(3, utf8ToBytes(s).length), utf8ToBytes(s));
export const cArr = (...items) => concatBytes(cborHead(4, items.length), ...items);
export const cMap = (...pairs) => concatBytes(cborHead(5, pairs.length / 2), ...pairs);

export class Dec {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }
  byte() {
    if (this.pos >= this.buf.length) throw new Error("cbor: truncated");
    return this.buf[this.pos++];
  }
  take(n) {
    const s = this.buf.slice(this.pos, this.pos + n);
    if (s.length !== n) throw new Error("cbor: truncated");
    this.pos += n;
    return s;
  }
  head() {
    const b = this.byte();
    const major = b >> 5;
    const info = b & 0x1f;
    let v;
    if (info < 24) v = info;
    else if (info === 24) v = this.byte();
    else if (info === 25) v = (this.byte() << 8) | this.byte();
    else if (info === 26) v = new DataView(this.take(4).buffer).getUint32(0);
    else throw new Error("cbor: unsupported");
    return [major, v];
  }
  uint() {
    const [m, v] = this.head();
    if (m !== 0) throw new Error("cbor: expected uint");
    return v;
  }
  int() {
    const [m, v] = this.head();
    if (m === 0) return v;
    if (m === 1) return -1 - v;
    throw new Error("cbor: expected int");
  }
  bstr() {
    const [m, v] = this.head();
    if (m !== 2) throw new Error("cbor: expected bstr");
    return this.take(v);
  }
  tstr() {
    const [m, v] = this.head();
    if (m !== 3) throw new Error("cbor: expected tstr");
    return new TextDecoder().decode(this.take(v));
  }
  array() {
    const [m, v] = this.head();
    if (m !== 4) throw new Error("cbor: expected array");
    return v;
  }
  map() {
    const [m, v] = this.head();
    if (m !== 5) throw new Error("cbor: expected map");
    return v;
  }
  skip(depth = 8) {
    if (!depth) throw new Error("cbor: deep");
    const [m, v] = this.head();
    if (m === 2 || m === 3) this.take(v);
    else if (m === 4) for (let i = 0; i < v; i++) this.skip(depth - 1);
    else if (m === 5) for (let i = 0; i < 2 * v; i++) this.skip(depth - 1);
    else if (m === 6) this.skip(depth - 1);
  }
}

// --- COSE (ekenv-v1) -------------------------------------------------------

export const SIGN1_PROTECTED = Uint8Array.of(0xa1, 0x01, 0x27); // {1: -8}

export function sign1(payload, kid, priv) {
  const sigStruct = cArr(cTstr("Signature1"), cBstr(SIGN1_PROTECTED), cBstr(new Uint8Array()), cBstr(payload));
  const sig = ed25519.sign(sigStruct, priv);
  const unprot = kid ? cMap(cInt(4), cBstr(kid)) : cMap();
  return cArr(cBstr(SIGN1_PROTECTED), unprot, cBstr(payload), cBstr(sig));
}

export function sign1Parse(blob) {
  const d = new Dec(blob);
  if (d.array() !== 4) throw new Error("not a Sign1");
  const prot = d.bstr();
  let kid = null;
  const n = d.map();
  for (let i = 0; i < n; i++) {
    if (d.int() === 4) kid = d.bstr();
    else d.skip();
  }
  return { protected: prot, kid, payload: d.bstr(), sig: d.bstr() };
}

export function seal(plaintext, kxPub, seq, target) {
  const ephPriv = crypto.getRandomValues(new Uint8Array(32));
  const ephPub = x25519.getPublicKey(ephPriv);
  const shared = x25519.getSharedSecret(ephPriv, kxPub);
  const key = hkdf(sha256, shared, ephPub, utf8ToBytes("ekenv-v1"), 16);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const prot = cMap(cInt(1), cInt(1), cInt(4), cBstr(target), cInt(-65537), cUint(seq));
  const aad = cArr(cTstr("Encrypt0"), cBstr(prot), cBstr(new Uint8Array()));
  const ct = gcm(key, iv, aad).encrypt(plaintext);
  const unprot = cMap(cInt(5), cBstr(iv), cInt(-65538), cBstr(ephPub));
  return cArr(cBstr(prot), unprot, cBstr(ct));
}

// --- serial framing --------------------------------------------------------

export const FT = {
  IDENTITY_REQ: 0x01, IDENTITY: 0x02, CHALLENGE: 0x03, CHALLENGE_SIG: 0x04,
  CONFIG_BEGIN: 0x10, CONFIG_CHUNK: 0x11, CONFIG_COMMIT: 0x12, CONFIG_ACK: 0x13,
  EVENTS_REQ: 0x30, EVENTS: 0x31,
  WIFI_SET: 0x40, WIFI_STATUS_REQ: 0x41, WIFI_STATUS: 0x42,
  OK: 0x7e, ERROR: 0x7f,
};

export function crc16(data) {
  let crc = 0xffff;
  for (const b of data) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

export function crc32(data) {
  let crc = 0xffffffff;
  for (const b of data) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function encodeFrame(type, payload = new Uint8Array()) {
  const body = new Uint8Array(4 + payload.length);
  body[0] = 0x01;
  body[1] = type;
  body[2] = payload.length & 0xff;
  body[3] = payload.length >> 8;
  body.set(payload, 4);
  const crc = crc16(body);
  return concatBytes(Uint8Array.of(0x45, 0x4b), body, Uint8Array.of(crc & 0xff, crc >> 8));
}

/** Request/response over a net.Socket speaking the framed protocol. */
export class FrameChannel {
  constructor(socket) {
    this.socket = socket;
    this.buf = new Uint8Array(0);
    this.waiters = [];
    this.frames = [];
    socket.on("data", (chunk) => this.push(new Uint8Array(chunk)));
  }
  push(chunk) {
    this.buf = concatBytes(this.buf, chunk);
    for (;;) {
      let s = 0;
      while (s + 1 < this.buf.length && !(this.buf[s] === 0x45 && this.buf[s + 1] === 0x4b)) s++;
      if (s) this.buf = this.buf.slice(s);
      if (this.buf.length < 8) return;
      const len = this.buf[4] | (this.buf[5] << 8);
      const total = 6 + len + 2;
      if (this.buf.length < total) return;
      const body = this.buf.slice(2, 6 + len);
      const want = this.buf[total - 2] | (this.buf[total - 1] << 8);
      if (crc16(body) === want) {
        const frame = { type: this.buf[3], payload: this.buf.slice(6, 6 + len) };
        this.buf = this.buf.slice(total);
        const w = this.waiters.shift();
        if (w) w(frame);
        else this.frames.push(frame);
      } else {
        this.buf = this.buf.slice(2);
      }
    }
  }
  async request(type, payload, timeoutMs = 4000) {
    this.socket.write(encodeFrame(type, payload));
    const queued = this.frames.shift();
    if (queued) return queued;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("frame timeout")), timeoutMs);
      this.waiters.push((f) => {
        clearTimeout(t);
        resolve(f);
      });
    });
  }
}

// --- EK1 API client --------------------------------------------------------

export function makeClient(base) {
  async function challenge(purpose = "manager") {
    const r = await fetch(`${base}/api/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ purpose }),
    });
    return hexToBytes((await r.json()).nonce);
  }
  function sign(priv, context, nonce, payload) {
    const msg = concatBytes(utf8ToBytes(context), nonce, sha256(payload));
    return bytesToHex(ed25519.sign(msg, priv));
  }
  async function ek1(priv, context, payload) {
    const nonce = await challenge("manager");
    return `EK1 ${bytesToHex(nonce)}:${sign(priv, context, nonce, payload)}`;
  }
  return {
    challenge,
    sign,
    async signedPost(priv, context, path, bodyObj) {
      const body = JSON.stringify(bodyObj);
      const auth = await ek1(priv, context, utf8ToBytes(body));
      const r = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: auth },
        body,
      });
      return { status: r.status, body: await r.json() };
    },
    async signedPostBytes(priv, path, bytes) {
      const auth = await ek1(priv, "ekctl-manager-v1", bytes);
      const r = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream", authorization: auth },
        body: bytes,
      });
      return { status: r.status, body: await r.json() };
    },
    async signedGetRaw(priv, path) {
      const auth = await ek1(priv, "ekctl-manager-v1", utf8ToBytes(path));
      return fetch(`${base}${path}`, { headers: { authorization: auth } });
    },
    async signedGet(priv, path) {
      const r = await this.signedGetRaw(priv, path);
      return { status: r.status, body: await r.json() };
    },
  };
}
