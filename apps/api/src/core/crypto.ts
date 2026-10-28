import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../config";

const key = Buffer.from(config.ENCRYPTION_KEY, "base64");
if (key.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes, base64-encoded");

/** AES-256-GCM. Output: v1.<iv>.<tag>.<ciphertext> (base64url). */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), enc.toString("base64url")].join(".");
}

export function decryptSecret(payload: string): string {
  const [version, iv, tag, data] = payload.split(".");
  if (version !== "v1" || !iv || !tag || !data) throw new Error("Unsupported secret format");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}

/** Shows only the last 4 characters of a secret. */
export function maskSecret(secret: string) {
  return secret.length <= 4 ? "••••" : `••••${secret.slice(-4)}`;
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

export function hmac(value: string) {
  return createHmac("sha256", config.URL_SIGNING_SECRET).update(value).digest("base64url");
}

export function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Human-friendly unguessable code, e.g. for certificate verification: XXXX-XXXX-XXXX. */
export function verificationCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(12);
  let out = "";
  for (let i = 0; i < 12; i++) {
    out += alphabet[bytes[i]! % alphabet.length];
    if (i % 4 === 3 && i < 11) out += "-";
  }
  return out;
}
