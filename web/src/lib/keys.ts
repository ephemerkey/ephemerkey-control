// Owner-key management. The Ed25519 owner key is the sole management
// credential: possession = authority (no accounts). All signing happens
// client-side; the backend never sees private key material.
//
// v1 stores the key extractable in localStorage so it can be exported and
// "sent around" to co-managers. Later: optional WebAuthn/passkey wrapping.

import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";

const STORAGE_KEY = "ekctl-pools-v1";
const LEGACY_KEY = "ekctl-owner-key-v1";

export interface OwnerKey {
  priv: Uint8Array; // 32-byte Ed25519 seed
  pub: Uint8Array; // 32-byte public key
}

export function generateOwnerKey(): OwnerKey {
  const priv = ed25519.utils.randomPrivateKey();
  return { priv, pub: ed25519.getPublicKey(priv) };
}

export function ownerKeyFromPriv(privHex: string): OwnerKey {
  const priv = hexToBytes(privHex);
  return { priv, pub: ed25519.getPublicKey(priv) };
}

/** set_id = SHA-256(owner_pub)[0..8], per ephemerkey DESIGN-management.md. */
export function setIdFromPub(pub: Uint8Array): string {
  return bytesToHex(sha256(pub).slice(0, 8));
}

// At-rest browser storage holds MULTIPLE pools, each independently either
// plaintext (opt-out) or passphrase-wrapped (Argon2id → XChaCha20-Poly1305,
// reusing the keyfile wrap). Wrapped pools keep set_id/owner_pub/name in
// cleartext so the switcher and unlock screen can label a pool before its
// passphrase is known. One pool is "active" at a time.

interface PoolRec {
  set_id: string;
  owner_pub: string;
  name?: string;
  enc: boolean;
  priv?: string; // enc === false
  wrapped?: string; // enc === true, base64
}
interface Store {
  v: 1;
  active: string | null; // set_id
  pools: Record<string, PoolRec>;
}

export interface PoolSummary {
  setId: string;
  ownerPub: string;
  name?: string;
  encrypted: boolean;
}

export type PoolState =
  | { kind: "none" }
  | { kind: "plain"; key: OwnerKey }
  | { kind: "locked"; setId: string; ownerPub: string };

function readStore(): Store {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      const p = JSON.parse(raw);
      if (p && p.v === 1) return p as Store;
    } catch {
      /* fall through to fresh store */
    }
  }
  // One-time migration of the single-key format (plaintext hex).
  const legacy = localStorage.getItem(LEGACY_KEY);
  if (legacy) {
    try {
      const key = ownerKeyFromPriv(legacy);
      const setId = setIdFromPub(key.pub);
      const store: Store = {
        v: 1,
        active: setId,
        pools: { [setId]: { set_id: setId, owner_pub: bytesToHex(key.pub), enc: false, priv: legacy } },
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
      localStorage.removeItem(LEGACY_KEY);
      return store;
    } catch {
      localStorage.removeItem(LEGACY_KEY);
    }
  }
  return { v: 1, active: null, pools: {} };
}

function writeStore(s: Store): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

export function listPools(): PoolSummary[] {
  const s = readStore();
  return Object.values(s.pools).map((p) => ({
    setId: p.set_id,
    ownerPub: p.owner_pub,
    name: p.name,
    encrypted: p.enc,
  }));
}

export function activeSetId(): string | null {
  return readStore().active;
}

export function setActive(setId: string | null): void {
  const s = readStore();
  s.active = setId && s.pools[setId] ? setId : null;
  writeStore(s);
}

/** State of a pool by id (default: the active one) without its passphrase. */
export function poolState(setId?: string | null): PoolState {
  const s = readStore();
  const id = setId ?? s.active;
  const p = id ? s.pools[id] : undefined;
  if (!p) return { kind: "none" };
  if (!p.enc) return { kind: "plain", key: ownerKeyFromPriv(p.priv!) };
  return { kind: "locked", setId: p.set_id, ownerPub: p.owner_pub };
}

export function isEncrypted(setId: string): boolean {
  return readStore().pools[setId]?.enc ?? false;
}

/** The wrapped blob for the unlock path. Null if the pool isn't encrypted. */
export function wrappedFor(setId: string): Uint8Array | null {
  const p = readStore().pools[setId];
  if (!p || !p.enc || !p.wrapped) return null;
  return Uint8Array.from(atob(p.wrapped), (c) => c.charCodeAt(0));
}

/** Add (or replace) a pool in plaintext and make it active. */
export function addPoolPlain(key: OwnerKey, name?: string): void {
  const s = readStore();
  const setId = setIdFromPub(key.pub);
  s.pools[setId] = {
    set_id: setId,
    owner_pub: bytesToHex(key.pub),
    name: name ?? s.pools[setId]?.name,
    enc: false,
    priv: bytesToHex(key.priv),
  };
  s.active = setId;
  writeStore(s);
}

/** Add (or replace) a pool wrapped under a passphrase; keeps it active. */
export function addPoolEncrypted(key: OwnerKey, wrapped: Uint8Array, name?: string): void {
  const s = readStore();
  const setId = setIdFromPub(key.pub);
  s.pools[setId] = {
    set_id: setId,
    owner_pub: bytesToHex(key.pub),
    name: name ?? s.pools[setId]?.name,
    enc: true,
    wrapped: btoa(String.fromCharCode(...wrapped)),
  };
  writeStore(s);
}

export function renamePool(setId: string, name: string): void {
  const s = readStore();
  if (s.pools[setId]) {
    s.pools[setId].name = name;
    writeStore(s);
  }
}

/** Remove a pool; returns the set_id to activate next (or null). */
export function removePool(setId: string): string | null {
  const s = readStore();
  delete s.pools[setId];
  if (s.active === setId) s.active = Object.keys(s.pools)[0] ?? null;
  writeStore(s);
  return s.active;
}

/** Export as a JSON keyfile for sharing with co-managers / backup. */
export function exportKeyFile(key: OwnerKey, name?: string): string {
  return JSON.stringify(
    {
      format: "ekctl-owner-key-v1",
      name: name ?? null,
      set_id: setIdFromPub(key.pub),
      owner_pub: bytesToHex(key.pub),
      owner_priv: bytesToHex(key.priv),
    },
    null,
    2,
  );
}

export function importKeyFile(json: string): OwnerKey {
  const parsed = JSON.parse(json);
  if (parsed.format !== "ekctl-owner-key-v1" || typeof parsed.owner_priv !== "string") {
    throw new Error("not an ekctl owner keyfile");
  }
  return ownerKeyFromPriv(parsed.owner_priv);
}

/**
 * EK1 request signature: Ed25519(priv, context || nonce || SHA-256(payload)).
 * Must match server/src/auth.rs verify_sig.
 */
export function signEk1(
  key: OwnerKey,
  context: string,
  nonce: Uint8Array,
  payload: Uint8Array,
): string {
  const ctx = utf8ToBytes(context);
  const digest = sha256(payload);
  const msg = new Uint8Array(ctx.length + nonce.length + digest.length);
  msg.set(ctx, 0);
  msg.set(nonce, ctx.length);
  msg.set(digest, ctx.length + nonce.length);
  return bytesToHex(ed25519.sign(msg, key.priv));
}
