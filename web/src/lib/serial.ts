// WebSerial transport for the ephemerkey framed protocol.
// Wire format: see ../../docs/serial-protocol.md — this file is the host-side
// reference implementation; the emulator/firmware must match it.

export const FRAME_VERSION = 0x01;
const MAGIC0 = 0x45; // 'E'
const MAGIC1 = 0x4b; // 'K'
const MAX_PAYLOAD = 1024;

export enum FrameType {
  IdentityReq = 0x01,
  Identity = 0x02,
  Challenge = 0x03,
  ChallengeSig = 0x04,
  ConfigBegin = 0x10,
  ConfigChunk = 0x11,
  ConfigCommit = 0x12,
  ConfigAck = 0x13,
  EventsReq = 0x30,
  Events = 0x31,
  WifiSet = 0x40,
  WifiStatusReq = 0x41,
  WifiStatus = 0x42,
  Ok = 0x7e,
  Error = 0x7f,
}

export interface Frame {
  type: FrameType;
  payload: Uint8Array;
}

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF, no reflection). */
export function crc16(data: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

export function encodeFrame(type: FrameType, payload: Uint8Array = new Uint8Array()): Uint8Array {
  if (payload.length > MAX_PAYLOAD) throw new Error("payload too large");
  const body = new Uint8Array(4 + payload.length); // ver type len16 payload
  body[0] = FRAME_VERSION;
  body[1] = type;
  body[2] = payload.length & 0xff;
  body[3] = payload.length >> 8;
  body.set(payload, 4);
  const crc = crc16(body);
  const out = new Uint8Array(2 + body.length + 2);
  out[0] = MAGIC0;
  out[1] = MAGIC1;
  out.set(body, 2);
  out[out.length - 2] = crc & 0xff;
  out[out.length - 1] = crc >> 8;
  return out;
}

/**
 * Incremental frame scanner. Feed it raw serial bytes; it skips non-frame
 * noise (boot logs) by hunting for the magic and drops frames with bad CRCs.
 */
export class FrameParser {
  private buf = new Uint8Array(0);

  push(chunk: Uint8Array): Frame[] {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf, 0);
    merged.set(chunk, this.buf.length);
    this.buf = merged;

    const frames: Frame[] = [];
    for (;;) {
      // Hunt for magic.
      let start = 0;
      while (
        start + 1 < this.buf.length &&
        !(this.buf[start] === MAGIC0 && this.buf[start + 1] === MAGIC1)
      ) {
        start++;
      }
      if (start > 0) this.buf = this.buf.slice(start);
      if (this.buf.length < 8) return frames; // magic(2) header(4) crc(2)

      const len = this.buf[4] | (this.buf[5] << 8);
      if (len > MAX_PAYLOAD || this.buf[2] !== FRAME_VERSION) {
        this.buf = this.buf.slice(2); // false sync; resume hunting
        continue;
      }
      const total = 2 + 4 + len + 2;
      if (this.buf.length < total) return frames;

      const body = this.buf.slice(2, 6 + len);
      const gotCrc = this.buf[total - 2] | (this.buf[total - 1] << 8);
      if (crc16(body) === gotCrc) {
        frames.push({ type: this.buf[3], payload: this.buf.slice(6, 6 + len) });
        this.buf = this.buf.slice(total);
      } else {
        this.buf = this.buf.slice(2); // corrupt; resync
      }
    }
  }
}

const CONFIG_CHUNK_DATA = 256;

/** One request/response exchange at a time, matching the device contract. */
export class EkSerial {
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private writer?: WritableStreamDefaultWriter<Uint8Array>;
  private parser = new FrameParser();
  private pending: Frame[] = [];
  private waiter?: (f: Frame) => void;

  constructor(private port: SerialPort) {}

  async open(): Promise<void> {
    await this.port.open({ baudRate: 115200 }); // USB-CDC ignores baud
    this.writer = this.port.writable!.getWriter();
    this.reader = this.port.readable!.getReader();
    void this.readLoop();
  }

  async close(): Promise<void> {
    await this.reader?.cancel().catch(() => {});
    this.writer?.releaseLock();
    await this.port.close().catch(() => {});
  }

  private async readLoop(): Promise<void> {
    try {
      for (;;) {
        const { value, done } = await this.reader!.read();
        if (done) return;
        if (!value) continue;
        for (const frame of this.parser.push(value)) {
          if (this.waiter) {
            const w = this.waiter;
            this.waiter = undefined;
            w(frame);
          } else {
            this.pending.push(frame);
          }
        }
      }
    } catch {
      // port went away; request() timeouts surface the failure
    }
  }

  private nextFrame(timeoutMs: number): Promise<Frame> {
    const queued = this.pending.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiter = undefined;
        reject(new Error("serial timeout"));
      }, timeoutMs);
      this.waiter = (f) => {
        clearTimeout(t);
        resolve(f);
      };
    });
  }

  async request(
    type: FrameType,
    payload: Uint8Array = new Uint8Array(),
    timeoutMs = 3000,
  ): Promise<Frame> {
    if (this.waiter) throw new Error("request already in flight");
    await this.writer!.write(encodeFrame(type, payload));
    const resp = await this.nextFrame(timeoutMs);
    if (resp.type === FrameType.Error) {
      const code = resp.payload[0] ?? -1;
      const reasons: Record<number, string> = {
        1: "device is in the wrong state",
        2: "signature rejected by the device",
        3: "sequence rollback — the device already has a newer config",
        4: "wrong owner — this device belongs to a different pool",
        5: "device storage failure",
        6: "transfer corrupted (CRC)",
        7: "the config requires a feature this device's firmware doesn't support",
      };
      throw new Error(reasons[code] ?? `device error code ${code}`);
    }
    return resp;
  }

  /** Read the device's self-signed enrollment doc (raw CBOR bytes). */
  async identify(): Promise<Uint8Array> {
    const f = await this.request(FrameType.IdentityReq);
    if (f.type !== FrameType.Identity) throw new Error(`unexpected frame ${f.type}`);
    return f.payload;
  }

  /** Stream a sealed config blob; resolves with the device's signed ack. */
  async pushConfig(seq: number, blob: Uint8Array): Promise<Uint8Array> {
    const begin = new Uint8Array(10);
    const dv = new DataView(begin.buffer);
    dv.setUint16(0, blob.length, true);
    dv.setUint32(2, seq, true);
    dv.setUint32(6, crc32(blob), true);
    await this.request(FrameType.ConfigBegin, begin);

    for (let off = 0; off < blob.length; off += CONFIG_CHUNK_DATA) {
      const slice = blob.slice(off, off + CONFIG_CHUNK_DATA);
      const chunk = new Uint8Array(2 + slice.length);
      new DataView(chunk.buffer).setUint16(0, off, true);
      chunk.set(slice, 2);
      await this.request(FrameType.ConfigChunk, chunk);
    }

    const ack = await this.request(FrameType.ConfigCommit, new Uint8Array(), 10_000);
    if (ack.type !== FrameType.ConfigAck) throw new Error(`unexpected frame ${ack.type}`);
    return ack.payload; // COSE_Sign1 config-ack, forwarded verbatim to the backend
  }
}

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function webSerialSupported(): boolean {
  return typeof navigator !== "undefined" && "serial" in navigator;
}
