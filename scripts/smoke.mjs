// End-to-end smoke test against a running ekctl-server, using the same
// signing scheme as web/src/lib/keys.ts + api.ts.
// Usage: node scripts/smoke.mjs   (server on 127.0.0.1:8399, fresh DB)
import {
  ed25519, x25519, sha256, bytesToHex, hexToBytes, utf8ToBytes, concatBytes,
  cUint, cBstr, cArr, cMap, sign1, seal, makeClient,
} from "./ekenv.mjs";

const BASE = "http://127.0.0.1:8399";
const client = makeClient(BASE);
const signedPost = client.signedPost.bind(client);
const signedPostBytes = client.signedPostBytes.bind(client);
const signedGetRaw = client.signedGetRaw.bind(client);
const signedGet = client.signedGet.bind(client);
const challenge = () => client.challenge("manager");
const sign = client.sign;

const results = [];
const check = (name, cond, detail) => {
  results.push(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) process.exitCode = 1;
};

const health = await (await fetch(`${BASE}/api/health`)).json();
check("health", health.ok === true);

const priv = ed25519.utils.randomPrivateKey();
const pub = ed25519.getPublicKey(priv);
const setId = bytesToHex(sha256(pub).slice(0, 16));

// Register the set (signature proves key possession).
let r = await signedPost(priv, "ekctl-register-v1", "/api/sets", { owner_pub: bytesToHex(pub), name: "smoke" });
check("register set", r.status === 200 && r.body.set_id === setId, JSON.stringify(r.body));

r = await signedPost(priv, "ekctl-register-v1", "/api/sets", { owner_pub: bytesToHex(pub), name: "smoke" });
check("duplicate register rejected", r.status === 409);

// Wrong key must be rejected.
const evil = ed25519.utils.randomPrivateKey();
r = await signedGet(evil, `/api/sets/${setId}`);
check("wrong-key roster rejected", r.status === 401);

// Nonce reuse must be rejected.
{
  const nonce = await challenge();
  const path = `/api/sets/${setId}`;
  const hdr = { authorization: `EK1 ${bytesToHex(nonce)}:${sign(priv, "ekctl-manager-v1", nonce, utf8ToBytes(path))}` };
  const first = await fetch(`${BASE}${path}`, { headers: hdr });
  const second = await fetch(`${BASE}${path}`, { headers: hdr });
  check("nonce single-use", first.status === 200 && second.status === 401);
}

// A GET signature must not be replayable against a different path.
{
  const nonce = await challenge();
  const sig = sign(priv, "ekctl-manager-v1", nonce, utf8ToBytes(`/api/sets/${setId}`));
  const cross = await fetch(`${BASE}/api/sets/${setId}/configs`, {
    headers: { authorization: `EK1 ${bytesToHex(nonce)}:${sig}` },
  });
  check("path-bound GET signature", cross.status === 401);
}

// Add a device with a real simulated keypair (enrollment doc fields).
const devIdBytes = crypto.getRandomValues(new Uint8Array(12));
const devId = bytesToHex(devIdBytes);
const devSignPriv = ed25519.utils.randomPrivateKey();
const devKxPriv = crypto.getRandomValues(new Uint8Array(32));
r = await signedPost(priv, "ekctl-manager-v1", `/api/sets/${setId}/devices`, {
  device_id: devId,
  sign_pub: bytesToHex(ed25519.getPublicKey(devSignPriv)),
  kx_pub: bytesToHex(x25519.getPublicKey(devKxPriv)),
  role: 2, name: "front door", fw: "0.1",
});
check("add device", r.status === 200, JSON.stringify(r.body));

// Seal a real envelope: Encrypt0(Sign1(config, owner), device_kx) at seq 1.
const configCbor = cMap(cUint(4), cUint(2)); // {4: 2} — role: lock-controller
const blobBytes = seal(sign1(configCbor, pub, priv), x25519.getPublicKey(devKxPriv), 1, devIdBytes);
const blob = Buffer.from(blobBytes).toString("base64");
r = await signedPost(priv, "ekctl-manager-v1", `/api/sets/${setId}/configs`, { device_id: devId, seq: 1, blob_b64: blob });
check("upload sealed config seq 1", r.status === 200, JSON.stringify(r.body));

// Envelope/request mismatches are rejected.
r = await signedPost(priv, "ekctl-manager-v1", `/api/sets/${setId}/configs`, { device_id: devId, seq: 2, blob_b64: blob });
check("header/seq mismatch rejected", r.status === 400);
r = await signedPost(priv, "ekctl-manager-v1", `/api/sets/${setId}/configs`, {
  device_id: devId, seq: 2, blob_b64: Buffer.from(crypto.getRandomValues(new Uint8Array(120))).toString("base64"),
});
check("non-envelope blob rejected", r.status === 400);

r = await signedPost(priv, "ekctl-manager-v1", `/api/sets/${setId}/configs`, { device_id: devId, seq: 1, blob_b64: blob });
check("seq rollback rejected", r.status === 409);

r = await signedGet(priv, `/api/sets/${setId}`);
check("roster", r.status === 200 && r.body.devices.length === 1 && r.body.devices[0].latest_seq === 1, JSON.stringify(r.body.devices?.[0]));

// Config history: list + re-download the pushed (still sealed) blob.
r = await signedGet(priv, `/api/sets/${setId}/configs`);
check("config history list", r.status === 200 && r.body.configs.length === 1 && r.body.configs[0].seq === 1, JSON.stringify(r.body));
{
  const resp = await signedGetRaw(priv, `/api/sets/${setId}/configs/${devId}/1`);
  const got = new Uint8Array(await resp.arrayBuffer());
  check("config history download", resp.status === 200 && Buffer.from(got).equals(Buffer.from(blobBytes)));
}

// Recovery source blob: upsert, replace, read back (manager-signed).
const source1 = crypto.getRandomValues(new Uint8Array(4096));
const source2 = crypto.getRandomValues(new Uint8Array(4096));
r = await signedPostBytes(priv, `/api/sets/${setId}/blobs/source`, source1);
check("put source blob", r.status === 200, JSON.stringify(r.body));
r = await signedPostBytes(priv, `/api/sets/${setId}/blobs/source`, source2);
check("replace source blob", r.status === 200);
{
  const resp = await signedGetRaw(priv, `/api/sets/${setId}/blobs/source`);
  const got = new Uint8Array(await resp.arrayBuffer());
  check("get source blob (latest)", resp.status === 200 && Buffer.from(got).equals(Buffer.from(source2)));
  const anon = await fetch(`${BASE}/api/sets/${setId}/blobs/source`);
  check("source blob requires auth", anon.status === 401);
}

// Keywrap: manager-signed upload, public download (fresh-browser bootstrap).
const wrap = crypto.getRandomValues(new Uint8Array(256));
r = await signedPostBytes(priv, `/api/sets/${setId}/blobs/keywrap`, wrap);
check("put keywrap blob", r.status === 200);
{
  const anon = await fetch(`${BASE}/api/sets/${setId}/blobs/keywrap`);
  const got = new Uint8Array(await anon.arrayBuffer());
  check("keywrap public fetch", anon.status === 200 && Buffer.from(got).equals(Buffer.from(wrap)));
}
{
  const bad = await fetch(`${BASE}/api/sets/${setId}/blobs/banana`);
  check("unknown blob kind rejected", bad.status === 400);
}

// Courier identify: requires a device-signed server challenge (proof the
// courier is physically holding the device).
async function identifyWith(signPriv) {
  const cres = await fetch(`${BASE}/api/challenge`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ purpose: "courier" }),
  });
  const nonce = hexToBytes((await cres.json()).nonce);
  const sig = ed25519.sign(concatBytes(utf8ToBytes("ek-identify-v1"), nonce), signPriv);
  return fetch(`${BASE}/api/courier/identify`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_id: devId, nonce: bytesToHex(nonce), challenge_sig: bytesToHex(sig) }),
  });
}

let cr = await identifyWith(devSignPriv);
let cb = await cr.json();
check("courier identify (challenge-signed)", cr.status === 200 && cb.pending === true && cb.seq === 1, JSON.stringify(cb));

cr = await identifyWith(ed25519.utils.randomPrivateKey());
check("courier identify wrong key rejected", cr.status === 401);

cr = await fetch(`${BASE}/api/courier/config/${devId}`);
const fetched = new Uint8Array(await cr.arrayBuffer());
check("courier fetch blob", cr.status === 200 && cr.headers.get("x-ek-seq") === "1" && Buffer.from(fetched).toString("base64") === blob);

// ESP32 device path: poll config, then confirm 204 when current.
cr = await fetch(`${BASE}/api/device/${devId}/config?after=0`);
check("device poll gets blob", cr.status === 200 && cr.headers.get("x-ek-seq") === "1");
cr = await fetch(`${BASE}/api/device/${devId}/config?after=1`);
check("device poll current → 204", cr.status === 204);

r = await signedGet(priv, `/api/sets/${setId}`);
check("last_seen updated", r.body.devices[0].last_seen_at != null);

// Device acks the config: Sign1({1: seq, 2: sha256(blob)}, device_key).
const ackPayload = cMap(cUint(1), cUint(1), cUint(2), cBstr(sha256(fetched)));
const ackB64 = Buffer.from(sign1(ackPayload, devIdBytes, devSignPriv)).toString("base64");
cr = await fetch(`${BASE}/api/courier/ack`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ device_id: devId, seq: 1, ack_b64: ackB64 }),
});
check("config-ack accepted", cr.status === 200, JSON.stringify(await cr.json()));

// Forged ack (wrong device key) is rejected.
const forged = Buffer.from(sign1(ackPayload, devIdBytes, ed25519.utils.randomPrivateKey())).toString("base64");
cr = await fetch(`${BASE}/api/courier/ack`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ device_id: devId, seq: 1, ack_b64: forged }),
});
check("forged ack rejected", cr.status === 401);

// Ack reflected everywhere: roster acked_seq, courier no longer pending.
r = await signedGet(priv, `/api/sets/${setId}`);
check("acked_seq updated", r.body.devices[0].acked_seq === 1);
cr = await identifyWith(devSignPriv);
cb = await cr.json();
check("courier sees device current", cb.pending === false && cb.acked_seq === 1);

// Telemetry: Sign1 over a CBOR event batch, posted as raw bytes.
const evt = (seq, ts, kind) =>
  cMap(cUint(1), cUint(seq), cUint(3), cUint(ts), cUint(4), cUint(kind), cUint(6), cBstr(new Uint8Array(20)));
const batch = sign1(cArr(evt(1, 1000, 1), evt(2, 1060, 2)), devIdBytes, devSignPriv);
cr = await fetch(`${BASE}/api/device/${devId}/events`, {
  method: "POST", headers: { "content-type": "application/octet-stream" }, body: batch,
});
cb = await cr.json();
check("event batch ingested", cr.status === 200 && cb.inserted === 2, JSON.stringify(cb));

// Redelivery dedupes on (device, seq).
cr = await fetch(`${BASE}/api/device/${devId}/events`, {
  method: "POST", headers: { "content-type": "application/octet-stream" }, body: batch,
});
cb = await cr.json();
check("event redelivery deduped", cr.status === 200 && cb.inserted === 0);

// Manager sees the verified events.
r = await signedGet(priv, `/api/sets/${setId}/events`);
check("events listed", r.status === 200 && r.body.events.length === 2, JSON.stringify(r.body.events?.[0]));

console.log(results.join("\n"));
