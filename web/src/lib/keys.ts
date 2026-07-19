// Owner-key management. The Ed25519 owner key is the sole management
// credential: possession = authority (no accounts). All signing happens
// client-side; the backend never sees private key material.
//
// v1 stores the key extractable in localStorage so it can be exported and
// "sent around" to co-managers. Later: optional WebAuthn/passkey wrapping.

import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";

const STORAGE_KEY = "ekctl-owner-key-v1";

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

export function saveOwnerKey(key: OwnerKey): void {
  localStorage.setItem(STORAGE_KEY, bytesToHex(key.priv));
}

export function loadOwnerKey(): OwnerKey | null {
  const hex = localStorage.getItem(STORAGE_KEY);
  return hex ? ownerKeyFromPriv(hex) : null;
}

export function forgetOwnerKey(): void {
  localStorage.removeItem(STORAGE_KEY);
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
