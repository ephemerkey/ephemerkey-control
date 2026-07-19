// otpauth:// export for non-ephemerkey generators — a plain authenticator
// app (Google Authenticator, etc.) holds a pool secret and mints its codes.
// ephemerkey TOTP is RFC 6238 over SHA-1, 30 s period (see totp.rs), so a
// standard authenticator interoperates with any lock key it shares a
// secret with — deliberately WITHOUT the geofence/display ritual an
// ephemerkey generator enforces.

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32 of raw secret bytes (no padding — authenticators accept it). */
export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export interface OtpKey {
  label: string; // account label shown in the app
  secret: string; // raw secret (its bytes are base32-encoded)
  digits: number;
  period?: number; // seconds, default 30
}

/** Build the otpauth://totp URI an authenticator app scans. */
export function otpauthUri(k: OtpKey, issuer = "ephemerkey"): string {
  const secretBytes = new TextEncoder().encode(k.secret);
  const params = new URLSearchParams({
    secret: base32(secretBytes),
    issuer,
    algorithm: "SHA1",
    digits: String(k.digits),
    period: String(k.period ?? 30),
  });
  const label = encodeURIComponent(`${issuer}:${k.label}`);
  return `otpauth://totp/${label}?${params.toString()}`;
}
