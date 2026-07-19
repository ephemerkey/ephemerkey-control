// Backend client. The backend is an *optional* sync layer (see DESIGN.md):
// everything here degrades to file export/import when offline.

import { hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import { OwnerKey, signEk1 } from "./keys";

export const CTX_REGISTER = "ekctl-register-v1";
export const CTX_MANAGER = "ekctl-manager-v1";

async function getChallenge(purpose: "manager" | "courier" | "device"): Promise<Uint8Array> {
  const res = await fetch("/api/challenge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ purpose }),
  });
  if (!res.ok) throw new Error(`challenge failed: ${res.status}`);
  const { nonce } = await res.json();
  return hexToBytes(nonce);
}

async function parseOrThrow(res: Response): Promise<any> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `http ${res.status}`);
  return body;
}

/** Owner-key-signed POST. `context` is CTX_REGISTER for /api/sets, else CTX_MANAGER. */
export async function signedPost(
  key: OwnerKey,
  context: string,
  path: string,
  bodyObj: unknown,
): Promise<any> {
  const body = JSON.stringify(bodyObj);
  const nonce = await getChallenge("manager");
  const sig = signEk1(key, context, nonce, utf8ToBytes(body));
  const nonceHex = Array.from(nonce, (b) => b.toString(16).padStart(2, "0")).join("");
  const res = await fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `EK1 ${nonceHex}:${sig}`,
    },
    body,
  });
  return parseOrThrow(res);
}

async function signedGetResponse(key: OwnerKey, path: string): Promise<Response> {
  const nonce = await getChallenge("manager");
  // GET signatures bind to the full request path (must match server-side).
  const sig = signEk1(key, CTX_MANAGER, nonce, utf8ToBytes(path));
  const nonceHex = Array.from(nonce, (b) => b.toString(16).padStart(2, "0")).join("");
  return fetch(path, { headers: { authorization: `EK1 ${nonceHex}:${sig}` } });
}

/** Owner-key-signed GET returning JSON. */
export async function signedGet(key: OwnerKey, path: string): Promise<any> {
  return parseOrThrow(await signedGetResponse(key, path));
}

/** Owner-key-signed GET returning opaque bytes (config/source blobs). */
export async function signedGetBytes(key: OwnerKey, path: string): Promise<Uint8Array> {
  const res = await signedGetResponse(key, path);
  if (!res.ok) throw new Error(`http ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Owner-key-signed POST of raw bytes (set blob upserts). */
export async function signedPostBytes(
  key: OwnerKey,
  path: string,
  bytes: Uint8Array,
): Promise<any> {
  const nonce = await getChallenge("manager");
  const sig = signEk1(key, CTX_MANAGER, nonce, bytes);
  const nonceHex = Array.from(nonce, (b) => b.toString(16).padStart(2, "0")).join("");
  const res = await fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      authorization: `EK1 ${nonceHex}:${sig}`,
    },
    body: bytes as unknown as BodyInit,
  });
  return parseOrThrow(res);
}

// --- Recovery layer: the backend is the durable copy, the browser a cache.

/** Upload the sealed config source-of-truth (encrypted to the owner key). */
export function putSourceBlob(key: OwnerKey, setId: string, sealed: Uint8Array): Promise<any> {
  return signedPostBytes(key, `/api/sets/${setId}/blobs/source`, sealed);
}

/** Pull the sealed source-of-truth back (fresh browser + keyfile = recovery). */
export function getSourceBlob(key: OwnerKey, setId: string): Promise<Uint8Array> {
  return signedGetBytes(key, `/api/sets/${setId}/blobs/source`);
}

/** Upload the passphrase-wrapped owner keyfile. */
export function putKeywrapBlob(key: OwnerKey, setId: string, wrapped: Uint8Array): Promise<any> {
  return signedPostBytes(key, `/api/sets/${setId}/blobs/keywrap`, wrapped);
}

/**
 * Fetch the passphrase-wrapped keyfile. Deliberately unauthenticated — it
 * bootstraps a browser that doesn't have the key yet; security rests on the
 * passphrase KDF (see DESIGN.md).
 */
export async function getKeywrapBlob(setId: string): Promise<Uint8Array> {
  const res = await fetch(`/api/sets/${setId}/blobs/keywrap`);
  if (!res.ok) throw new Error(`no keywrap stored (http ${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

/** History of pushed (sealed) config blobs, for audit/recovery. */
export function listConfigs(key: OwnerKey, setId: string): Promise<any> {
  return signedGet(key, `/api/sets/${setId}/configs`);
}

/** Download one pushed blob (still sealed to its device) for re-push/export. */
export function getConfigBlob(
  key: OwnerKey,
  setId: string,
  deviceId: string,
  seq: number,
): Promise<Uint8Array> {
  return signedGetBytes(key, `/api/sets/${setId}/configs/${deviceId}/${seq}`);
}

// Courier endpoints need no owner key — but identify requires proof the
// courier is physically holding the device (it signs a server challenge).
export async function courierChallenge(): Promise<Uint8Array> {
  return getChallenge("courier");
}

export async function courierIdentify(
  deviceIdHex: string,
  nonce: Uint8Array,
  challengeSig: Uint8Array,
  enrollmentDoc?: Uint8Array,
): Promise<any> {
  const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  const res = await fetch("/api/courier/identify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      device_id: deviceIdHex,
      nonce: toHex(nonce),
      challenge_sig: toHex(challengeSig),
      // attested fw refresh: the device-signed identity doc, if we have it
      enrollment_b64: enrollmentDoc ? btoa(String.fromCharCode(...enrollmentDoc)) : undefined,
    }),
  });
  return parseOrThrow(res);
}

export async function courierAck(
  deviceIdHex: string,
  seq: number,
  ack: Uint8Array,
): Promise<any> {
  const res = await fetch("/api/courier/ack", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      device_id: deviceIdHex,
      seq,
      ack_b64: btoa(String.fromCharCode(...ack)),
    }),
  });
  return parseOrThrow(res);
}

export async function courierFetchConfig(
  deviceIdHex: string,
): Promise<{ seq: number; blob: Uint8Array }> {
  const res = await fetch(`/api/courier/config/${deviceIdHex}`);
  if (!res.ok) throw new Error(`no pending config (http ${res.status})`);
  const seq = Number(res.headers.get("x-ek-seq") ?? "0");
  return { seq, blob: new Uint8Array(await res.arrayBuffer()) };
}
