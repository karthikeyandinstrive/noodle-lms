import { createHmac, randomBytes } from "node:crypto";
import { safeEqual, sha256 } from "../../core/crypto";

/**
 * TOTP (RFC 6238) on top of HOTP (RFC 4226), using node:crypto only.
 * Defaults: HMAC-SHA-1, 6 digits, 30 s step, ±1 step tolerance.
 */

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const TOTP_WINDOW = 1;

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error("Invalid base32 character");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 20 random bytes (160 bits, the RFC 4226 recommendation), base32-encoded. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export type HashAlgorithm = "sha1" | "sha256" | "sha512";

/** HOTP value for a counter (RFC 4226 §5.3 dynamic truncation). */
export function hotp(key: Buffer, counter: number, digits = TOTP_DIGITS, algorithm: HashAlgorithm = "sha1"): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm, key).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) | ((mac[offset + 1]! & 0xff) << 16) | ((mac[offset + 2]! & 0xff) << 8) | (mac[offset + 3]! & 0xff);
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export const timeStep = (timeMs = Date.now(), stepSeconds = TOTP_STEP_SECONDS) => Math.floor(timeMs / 1000 / stepSeconds);

export function totp(key: Buffer, timeMs = Date.now(), opts: { digits?: number; algorithm?: HashAlgorithm; stepSeconds?: number } = {}) {
  return hotp(key, timeStep(timeMs, opts.stepSeconds), opts.digits ?? TOTP_DIGITS, opts.algorithm ?? "sha1");
}

/**
 * Verifies a 6-digit code within ±TOTP_WINDOW steps. Returns the matched step,
 * or null. Steps at or before `lastUsedStep` are rejected (replay protection).
 */
export function verifyTotp(secretBase32: string, code: string, opts: { timeMs?: number; lastUsedStep?: number | null } = {}): number | null {
  const normalized = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(normalized)) return null;
  const key = base32Decode(secretBase32);
  const current = timeStep(opts.timeMs ?? Date.now());
  let matched: number | null = null;
  // Check every candidate (no early exit) so timing doesn't reveal which step matched.
  for (let step = current - TOTP_WINDOW; step <= current + TOTP_WINDOW; step++) {
    if (safeEqual(hotp(key, step), normalized) && matched === null) matched = step;
  }
  if (matched === null) return null;
  if (opts.lastUsedStep != null && matched <= opts.lastUsedStep) return null;
  return matched;
}

export function otpauthUri(input: { secret: string; issuer: string; account: string }) {
  const label = encodeURIComponent(`${input.issuer}:${input.account}`);
  const params = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ─── Recovery codes ─────────────────────────────────────────────────────────

const RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** "xxxxx-xxxxx" codes (~49 bits each). */
export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const bytes = randomBytes(10);
    let s = "";
    for (let i = 0; i < 10; i++) s += RECOVERY_ALPHABET[bytes[i]! % RECOVERY_ALPHABET.length];
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}

export const normalizeRecoveryCode = (code: string) => code.toLowerCase().replace(/[^a-z0-9]/g, "");
export const hashRecoveryCode = (code: string) => sha256(`mfa-recovery:${normalizeRecoveryCode(code)}`);
