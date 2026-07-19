// Recovery crypto (see DESIGN.md "Recovery" + "Owner-key custody"):
//  - keywrap: the owner keyfile encrypted under a passphrase (Argon2id →
//    XChaCha20-Poly1305), safe to park on the backend for fresh-browser
//    bootstrap.
//  - source sealing: the config source-of-truth encrypted to the
//    owner-derived X25519 key (ECIES-style), so backend-stored state is
//    recoverable with nothing but the seed.
// Everything derives from the single 32-byte owner seed.

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519";
import { argon2id } from "@noble/hashes/argon2";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils";

const KEYWRAP_MAGIC = utf8ToBytes("EKW1");
const SOURCE_MAGIC = utf8ToBytes("EKS1");
const KEYWRAP_AAD = utf8ToBytes("ekctl-keywrap-v1");
const SOURCE_AAD = utf8ToBytes("ekctl-source-v1");

// OWASP-recommended Argon2id parameters (m in KiB). Stored in the header so
// they can be raised later without breaking old wraps.
const KDF = { t: 2, mKiB: 19456, p: 1 };

function rand(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

// --- keywrap -------------------------------------------------------------

/** Encrypt a keyfile JSON string under a passphrase. */
export function wrapKeyfile(keyfileJson: string, passphrase: string): Uint8Array {
  if (passphrase.length < 8) throw new Error("passphrase must be at least 8 characters");
  const salt = rand(16);
  const nonce = rand(24);
  const key = argon2id(utf8ToBytes(passphrase), salt, { ...toArgon(KDF), dkLen: 32 });
  const ct = xchacha20poly1305(key, nonce, KEYWRAP_AAD).encrypt(utf8ToBytes(keyfileJson));

  const header = new Uint8Array(4 + 6);
  header.set(KEYWRAP_MAGIC, 0);
  const dv = new DataView(header.buffer);
  dv.setUint8(4, KDF.t);
  dv.setUint32(5, KDF.mKiB, true);
  dv.setUint8(9, KDF.p);
  return concatBytes(header, salt, nonce, ct);
}

/** Decrypt a keywrap blob; throws on wrong passphrase or corrupt blob. */
export function unwrapKeyfile(blob: Uint8Array, passphrase: string): string {
  if (blob.length < 10 + 16 + 24 + 16 || !startsWith(blob, KEYWRAP_MAGIC)) {
    throw new Error("not an ekctl keywrap blob");
  }
  const dv = new DataView(blob.buffer, blob.byteOffset);
  const params = { t: dv.getUint8(4), mKiB: dv.getUint32(5, true), p: dv.getUint8(9) };
  if (params.mKiB > 1 << 20) throw new Error("unreasonable KDF parameters");
  const salt = blob.slice(10, 26);
  const nonce = blob.slice(26, 50);
  const ct = blob.slice(50);
  const key = argon2id(utf8ToBytes(passphrase), salt, { ...toArgon(params), dkLen: 32 });
  try {
    const pt = xchacha20poly1305(key, nonce, KEYWRAP_AAD).decrypt(ct);
    return new TextDecoder().decode(pt);
  } catch {
    throw new Error("wrong passphrase (or corrupted backup)");
  }
}

function toArgon(p: { t: number; mKiB: number; p: number }) {
  return { t: p.t, m: p.mKiB, p: p.p };
}

// --- owner-derived X25519 + source sealing --------------------------------

/** kx keypair derived from the owner seed: HKDF(seed, "ekctl-kx-v1"). */
export function deriveKx(seed: Uint8Array): { priv: Uint8Array; pub: Uint8Array } {
  const priv = hkdf(sha256, seed, undefined, "ekctl-kx-v1", 32);
  return { priv, pub: x25519.getPublicKey(priv) };
}

/**
 * ECIES-style seal to an X25519 public key: ephemeral keypair → shared
 * secret → HKDF → XChaCha20-Poly1305. Anyone with the pub can seal; only
 * the seed holder can open.
 */
export function sealToKx(kxPub: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const ephPriv = x25519.utils.randomPrivateKey();
  const ephPub = x25519.getPublicKey(ephPriv);
  const shared = x25519.getSharedSecret(ephPriv, kxPub);
  const key = hkdf(sha256, shared, ephPub, "ekctl-source-v1", 32);
  const nonce = rand(24);
  const ct = xchacha20poly1305(key, nonce, SOURCE_AAD).encrypt(plaintext);
  return concatBytes(SOURCE_MAGIC, ephPub, nonce, ct);
}

/** Open a sealed blob with the owner seed. */
export function unsealWithSeed(seed: Uint8Array, blob: Uint8Array): Uint8Array {
  if (blob.length < 4 + 32 + 24 + 16 || !startsWith(blob, SOURCE_MAGIC)) {
    throw new Error("not an ekctl sealed blob");
  }
  const ephPub = blob.slice(4, 36);
  const nonce = blob.slice(36, 60);
  const ct = blob.slice(60);
  const { priv } = deriveKx(seed);
  const shared = x25519.getSharedSecret(priv, ephPub);
  const key = hkdf(sha256, shared, ephPub, "ekctl-source-v1", 32);
  try {
    return xchacha20poly1305(key, nonce, SOURCE_AAD).decrypt(ct);
  } catch {
    throw new Error("cannot decrypt: wrong key or corrupted blob");
  }
}

function startsWith(buf: Uint8Array, prefix: Uint8Array): boolean {
  return prefix.every((b, i) => buf[i] === b);
}
