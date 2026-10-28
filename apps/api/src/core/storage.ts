import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import path from "node:path";
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { eq } from "drizzle-orm";
import { storageConfigs, type DB } from "@lms/db";
import { config } from "../config";
import { decryptSecret, hmac, safeEqual } from "./crypto";
import { badRequest } from "./errors";

export type Provider = "local" | "s3" | "minio" | "r2";

export type StorageConfig = {
  provider: Provider;
  endpoint?: string | null;
  region?: string | null;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};

export interface StorageDriver {
  provider: Provider;
  /** URL the browser PUTs the file to directly (no proxying large uploads through the API). */
  presignUpload(key: string, contentType: string, maxBytes: number, expiresIn?: number): Promise<string>;
  presignDownload(key: string, filename: string, expiresIn?: number, inline?: boolean): Promise<string>;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  head(key: string): Promise<{ size: number } | null>;
  delete(key: string): Promise<void>;
  /** Deletes every object under `prefix/` (a "folder", e.g. an extracted package). */
  deletePrefix(prefix: string): Promise<void>;
  test(): Promise<void>;
}

// ─── S3-compatible (AWS S3, MinIO, Cloudflare R2) ───────────────────────────

export class S3Driver implements StorageDriver {
  private client: S3Client;
  constructor(private cfg: StorageConfig) {
    this.client = new S3Client({
      region: cfg.region || "auto",
      endpoint: cfg.endpoint || undefined,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
      forcePathStyle: cfg.provider === "minio",
    });
  }
  get provider() {
    return this.cfg.provider;
  }
  presignUpload(key: string, contentType: string, _maxBytes: number, expiresIn = 900) {
    return getSignedUrl(this.client, new PutObjectCommand({ Bucket: this.cfg.bucket, Key: key, ContentType: contentType }), {
      expiresIn,
    });
  }
  presignDownload(key: string, filename: string, expiresIn = 300, inline = false) {
    const disposition = `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(filename)}`;
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key, ResponseContentDisposition: disposition }),
      { expiresIn },
    );
  }
  async put(key: string, body: Buffer, contentType: string) {
    await this.client.send(new PutObjectCommand({ Bucket: this.cfg.bucket, Key: key, Body: body, ContentType: contentType }));
  }
  async get(key: string) {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
    return Buffer.from(await res.Body!.transformToByteArray());
  }
  async head(key: string) {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
      return { size: res.ContentLength ?? 0 };
    } catch {
      return null;
    }
  }
  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
  }
  async deletePrefix(prefix: string) {
    let token: string | undefined;
    do {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.cfg.bucket, Prefix: `${prefix}/`, ContinuationToken: token }));
      const keys = (page.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
      // ListObjectsV2 returns at most 1,000 keys, which is also DeleteObjects' limit.
      if (keys.length) await this.client.send(new DeleteObjectsCommand({ Bucket: this.cfg.bucket, Delete: { Objects: keys, Quiet: true } }));
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }
  async test() {
    await this.client.send(new HeadBucketCommand({ Bucket: this.cfg.bucket }));
  }
}

// ─── Local filesystem (development / single-node self-hosting) ──────────────

const localRoot = path.resolve(process.env.LMS_ROOT ?? path.resolve(import.meta.dirname, "../../../.."), config.STORAGE_LOCAL_DIR);

function localPath(key: string) {
  const full = path.resolve(localRoot, key);
  if (!full.startsWith(localRoot + path.sep)) throw badRequest("Invalid storage key");
  return full;
}

/** Signed URL params for the local driver; verified by the /files/local routes. */
export function signLocal(op: "get" | "put", key: string, expiresIn: number, extra = "") {
  const exp = Math.floor(Date.now() / 1000) + expiresIn;
  const sig = hmac(`${op}:${key}:${exp}:${extra}`);
  return { exp, sig };
}

export function verifyLocal(op: "get" | "put", key: string, exp: number, sig: string, extra = "") {
  if (exp < Date.now() / 1000) return false;
  return safeEqual(sig, hmac(`${op}:${key}:${exp}:${extra}`));
}

export class LocalDriver implements StorageDriver {
  provider = "local" as const;
  async presignUpload(key: string, contentType: string, maxBytes: number, expiresIn = 900) {
    const { exp, sig } = signLocal("put", key, expiresIn, `${contentType}:${maxBytes}`);
    const q = new URLSearchParams({ key, exp: String(exp), sig, type: contentType, max: String(maxBytes) });
    return `/api/v1/files/local?${q}`;
  }
  async presignDownload(key: string, filename: string, expiresIn = 300, inline = false) {
    const { exp, sig } = signLocal("get", key, expiresIn);
    const q = new URLSearchParams({ key, exp: String(exp), sig, name: filename, inline: inline ? "1" : "0" });
    return `/api/v1/files/local?${q}`;
  }
  async put(key: string, body: Buffer) {
    const file = localPath(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
  }
  get(key: string) {
    return readFile(localPath(key));
  }
  async head(key: string) {
    try {
      return { size: (await stat(localPath(key))).size };
    } catch {
      return null;
    }
  }
  async delete(key: string) {
    await rm(localPath(key), { force: true });
  }
  async deletePrefix(prefix: string) {
    await rm(localPath(prefix), { recursive: true, force: true });
  }
  async test() {
    await mkdir(localRoot, { recursive: true });
  }
}

// ─── Resolution per organization ────────────────────────────────────────────

function platformDriver(): StorageDriver {
  if (config.STORAGE_DRIVER === "local") return new LocalDriver();
  return new S3Driver({
    provider: config.STORAGE_DRIVER,
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    bucket: config.S3_BUCKET!,
    accessKeyId: config.S3_ACCESS_KEY_ID!,
    secretAccessKey: config.S3_SECRET_ACCESS_KEY!,
  });
}

/** The organization's own storage if enabled, otherwise the platform default. */
export async function storageFor(tx: DB, organizationId: string): Promise<StorageDriver> {
  const [cfg] = await tx.select().from(storageConfigs).where(eq(storageConfigs.organizationId, organizationId)).limit(1);
  if (!cfg?.enabled || cfg.provider === "local") return platformDriver();
  return new S3Driver({
    provider: cfg.provider,
    endpoint: cfg.endpoint,
    region: cfg.region,
    bucket: cfg.bucket,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: decryptSecret(cfg.secretAccessKeyEnc),
  });
}

/** Driver for a specific provider, used to read files written before the org switched provider. */
export async function driverForFile(tx: DB, organizationId: string, provider: Provider) {
  const current = await storageFor(tx, organizationId);
  if (current.provider === provider) return current;
  return platformDriver();
}

// ─── SSRF protection for user-supplied endpoints ────────────────────────────

function isPrivateAddress(ip: string) {
  if (ip.includes(":")) {
    const v = ip.toLowerCase();
    return v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v.startsWith("::ffff:");
  }
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/**
 * Rejects storage endpoints that resolve to private/link-local addresses
 * (e.g. cloud metadata at 169.254.169.254) unless explicitly allowed.
 */
export async function assertSafeEndpoint(endpoint: string) {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw badRequest("Endpoint must be a valid URL");
  }
  if (!["https:", "http:"].includes(url.protocol)) throw badRequest("Endpoint must use http(s)");
  if (config.isProd && url.protocol !== "https:" && !config.ALLOW_PRIVATE_STORAGE_ENDPOINTS) {
    throw badRequest("Endpoint must use https");
  }
  if (config.ALLOW_PRIVATE_STORAGE_ENDPOINTS) return;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (addresses.some(isPrivateAddress)) throw badRequest("Endpoint resolves to a private network address");
}
