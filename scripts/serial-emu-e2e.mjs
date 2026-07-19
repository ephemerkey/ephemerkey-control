// Full courier-loop e2e against the REAL device implementation stand-in:
// ekemu serial (ephemerkey repo, Rust: ephemerkey-frame + ephemerkey-envelope)
// + ekctl-server. Covers: identity, challenge-proof, TOFU owner binding,
// sealed config transfer, signed ack, seq rollback, wrong-owner rejection,
// telemetry pull->push, wifi config.
//
// Usage: node scripts/serial-emu-e2e.mjs
// (spawns its own server + emulator; needs both repos built side by side)

import { spawn } from "node:child_process";
import net from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ed25519, sha256, bytesToHex, utf8ToBytes, concatBytes,
  cUint, cInt, cBstr, cTstr, cMap, Dec, sign1, sign1Parse, seal,
  FT, FrameChannel, crc32, makeClient,
} from "./ekenv.mjs";

const SERVER = "http://127.0.0.1:8402";
const EMU_ADDR = { host: "127.0.0.1", port: 8423 };
const ROOT = new URL("..", import.meta.url).pathname;

const results = [];
const check = (name, cond, detail) => {
  results.push(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) process.exitCode = 1;
};

async function waitFor(probe, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      return await probe();
    } catch {
      if (Date.now() > end) throw new Error("timeout waiting for service");
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

const tmp = mkdtempSync(join(tmpdir(), "ek-e2e-"));
const server = spawn(join(ROOT, "target/debug/ekctl-server"), [], {
  env: { ...process.env, EKCTL_DB: join(tmp, "e2e.db"), EKCTL_LISTEN: "127.0.0.1:8402", RUST_LOG: "warn" },
  stdio: "inherit",
});
const emu = spawn(
  join(ROOT, "../ephemerkey/firmware/ephemerkey-emu/target/debug/ekemu"),
  ["serial", join(tmp, "device.json"), `${EMU_ADDR.host}:${EMU_ADDR.port}`],
  { stdio: "inherit" },
);
process.on("exit", () => {
  server.kill();
  emu.kill();
});

try {
  await waitFor(async () => {
    const r = await fetch(`${SERVER}/api/health`);
    if (!r.ok) throw new Error("not up");
  });
  const sock = await waitFor(
    () =>
      new Promise((resolve, reject) => {
        const s = net.connect(EMU_ADDR, () => resolve(s));
        s.on("error", reject);
      }),
  );
  const chan = new FrameChannel(sock);
  const client = makeClient(SERVER);

  // Owner registers a set.
  const ownerPriv = ed25519.utils.randomPrivateKey();
  const ownerPub = ed25519.getPublicKey(ownerPriv);
  const setId = bytesToHex(sha256(ownerPub).slice(0, 16));
  let r = await client.signedPost(ownerPriv, "ekctl-register-v1", "/api/sets", {
    owner_pub: bytesToHex(ownerPub), name: "e2e",
  });
  check("register set", r.status === 200);

  // IDENTITY: self-signed enrollment doc from the emulator.
  const idFrame = await chan.request(FT.IDENTITY_REQ, new Uint8Array());
  check("identity frame", idFrame.type === FT.IDENTITY);
  const parts = sign1Parse(idFrame.payload);
  const d = new Dec(parts.payload);
  const fields = {};
  const nf = d.map();
  for (let i = 0; i < nf; i++) {
    const k = d.uint();
    if (k === 4) fields[k] = d.tstr();
    else fields[k] = d.bstr();
  }
  const devId = bytesToHex(fields[1]);
  const devSignPub = fields[2];
  const devKxPub = fields[3];
  check("enrollment doc fields", devId.length === 24 && devSignPub.length === 32 && devKxPub.length === 32, `fw=${fields[4]}`);

  // Enroll it under the set.
  r = await client.signedPost(ownerPriv, "ekctl-manager-v1", `/api/sets/${setId}/devices`, {
    device_id: devId, sign_pub: bytesToHex(devSignPub), kx_pub: bytesToHex(devKxPub),
    role: 2, name: "emu lock", fw: "stale-0.0",
  });
  check("enroll device", r.status === 200, JSON.stringify(r.body));

  // Courier challenge proof: server nonce -> device signature -> identify.
  const nonce = await client.challenge("courier");
  const sigFrame = await chan.request(FT.CHALLENGE, nonce);
  check("challenge_sig frame", sigFrame.type === FT.CHALLENGE_SIG && sigFrame.payload.length === 64);
  let cr = await fetch(`${SERVER}/api/courier/identify`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      device_id: devId, nonce: bytesToHex(nonce), challenge_sig: bytesToHex(sigFrame.payload),
      enrollment_b64: Buffer.from(idFrame.payload).toString("base64"),
    }),
  });
  let cb = await cr.json();
  check("identify via device sig", cr.status === 200 && cb.pending === false, JSON.stringify(cb));

  // The self-signed identity doc refreshed the roster's fw (attested).
  let rr = await client.signedGet(ownerPriv, `/api/sets/${setId}`);
  check("attested fw refresh", rr.body.devices[0].fw === fields[4], `fw=${rr.body.devices[0].fw}`);

  // Manager seals a config (kid = owner_pub for TOFU) and uploads it.
  const cfgJson = utf8ToBytes(JSON.stringify({ role: 2, keys: [], slots: [] }));
  const sealed = seal(sign1(cfgJson, ownerPub, ownerPriv), devKxPub, 1, fields[1]);
  r = await client.signedPost(ownerPriv, "ekctl-manager-v1", `/api/sets/${setId}/configs`, {
    device_id: devId, seq: 1, blob_b64: Buffer.from(sealed).toString("base64"),
  });
  check("upload sealed config", r.status === 200);

  // Courier fetches and streams it to the device.
  cr = await fetch(`${SERVER}/api/courier/config/${devId}`);
  const blob = new Uint8Array(await cr.arrayBuffer());
  check("courier fetch", cr.status === 200 && blob.length === sealed.length);

  async function pushBlob(bytes, seq) {
    const begin = new Uint8Array(10);
    const dv = new DataView(begin.buffer);
    dv.setUint16(0, bytes.length, true);
    dv.setUint32(2, seq, true);
    dv.setUint32(6, crc32(bytes), true);
    let f = await chan.request(FT.CONFIG_BEGIN, begin);
    if (f.type !== FT.OK) return f;
    for (let off = 0; off < bytes.length; off += 256) {
      const slice = bytes.slice(off, off + 256);
      const chunk = new Uint8Array(2 + slice.length);
      new DataView(chunk.buffer).setUint16(0, off, true);
      chunk.set(slice, 2);
      f = await chan.request(FT.CONFIG_CHUNK, chunk);
      if (f.type !== FT.OK) return f;
    }
    return chan.request(FT.CONFIG_COMMIT, new Uint8Array(), 8000);
  }

  const ackFrame = await pushBlob(blob, 1);
  check("device applies config (TOFU) & acks", ackFrame.type === FT.CONFIG_ACK, `type=0x${ackFrame.type.toString(16)}`);

  // Relay the device ack to the server.
  cr = await fetch(`${SERVER}/api/courier/ack`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_id: devId, seq: 1, ack_b64: Buffer.from(ackFrame.payload).toString("base64") }),
  });
  check("server verifies emu ack", cr.status === 200, JSON.stringify(await cr.json()));

  // Replay = seq rollback at the device.
  const replay = await pushBlob(blob, 1);
  check("seq rollback rejected by device", replay.type === FT.ERROR && replay.payload[0] === 3, `type=0x${replay.type.toString(16)} code=${replay.payload[0]}`);

  // A different owner cannot reconfigure a bound device (TOFU).
  const evilPriv = ed25519.utils.randomPrivateKey();
  const evilSealed = seal(sign1(cfgJson, ed25519.getPublicKey(evilPriv), evilPriv), devKxPub, 2, fields[1]);
  const evil = await pushBlob(evilSealed, 2);
  check("wrong owner rejected (wrong-set)", evil.type === FT.ERROR && evil.payload[0] === 4, `code=${evil.payload?.[0]}`);

  // Critical features: unknown crit -> refused (error 7), known -> accepted.
  const critBad = seal(
    sign1(utf8ToBytes(JSON.stringify({ role: 2, keys: [], slots: [], crit: ["time-travel"] })), ownerPub, ownerPriv),
    devKxPub, 2, fields[1],
  );
  const badResp = await pushBlob(critBad, 2);
  check("unknown critical feature refused", badResp.type === FT.ERROR && badResp.payload[0] === 7, `code=${badResp.payload?.[0]}`);

  const critGood = seal(
    sign1(utf8ToBytes(JSON.stringify({ role: 2, keys: [], slots: [], crit: ["seq-jitter", "quorum-pace"] })), ownerPub, ownerPriv),
    devKxPub, 2, fields[1],
  );
  const goodResp = await pushBlob(critGood, 2);
  check("known critical features accepted", goodResp.type === FT.CONFIG_ACK, `type=0x${goodResp.type.toString(16)}`);

  // Pull the device's signed event log and relay it to the server.
  const evFrame = await chan.request(FT.EVENTS_REQ, Uint8Array.of(0, 0, 0, 0));
  check("events frame", evFrame.type === FT.EVENTS);
  cr = await fetch(`${SERVER}/api/device/${devId}/events`, {
    method: "POST", headers: { "content-type": "application/octet-stream" }, body: evFrame.payload,
  });
  cb = await cr.json();
  check("server ingests emu events", cr.status === 200 && cb.inserted >= 1, JSON.stringify(cb));

  // WiFi provisioning frames.
  let wf = await chan.request(FT.WIFI_SET, cMap(cUint(1), cTstr("e2e-net"), cUint(2), cTstr("hunter22")));
  check("wifi set", wf.type === FT.OK);
  wf = await chan.request(FT.WIFI_STATUS_REQ, new Uint8Array());
  const wd = new Dec(wf.payload);
  const wn = wd.map();
  let ssid = "";
  for (let i = 0; i < wn; i++) {
    const k = wd.uint();
    if (k === 2) ssid = wd.tstr();
    else wd.skip();
  }
  check("wifi status echoes ssid", wf.type === FT.WIFI_STATUS && ssid === "e2e-net", `ssid=${ssid}`);

  sock.end();
} finally {
  server.kill();
  emu.kill();
}

console.log(results.join("\n"));
