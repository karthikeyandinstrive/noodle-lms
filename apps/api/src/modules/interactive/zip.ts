import { inflateRawSync } from "node:zlib";

/**
 * Minimal, dependency-free ZIP reader for H5P packages (.h5p files are ZIPs).
 *
 * Supports the subset H5P tooling produces: stored (0) and deflate (8) entries,
 * no encryption, no ZIP64, single disk. Defensive limits guard against zip bombs
 * and path traversal ("zip slip"): every entry name is normalized and rejected if
 * it is absolute or escapes the archive root.
 */

export type ZipEntry = { name: string; method: number; compressedSize: number; size: number; crc: number; localOffset: number };

export type ZipLimits = { maxEntries: number; maxEntrySize: number; maxTotalSize: number };

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 10_000,
  maxEntrySize: 100 * 1024 * 1024,
  maxTotalSize: 500 * 1024 * 1024,
};

export class ZipError extends Error {}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Normalizes an archive path; returns null for unsafe names (absolute, traversal, control chars). */
export function safeEntryPath(name: string): string | null {
  if (!name || name.length > 500) return null;
  if (/[\u0000-\u001f\\]/.test(name)) return null;
  if (name.startsWith("/") || /^[a-zA-Z]:/.test(name)) return null;
  const parts: string[] = [];
  for (const part of name.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") return null;
    parts.push(part);
  }
  return parts.length ? parts.join("/") : null;
}

function findEocd(buf: Buffer) {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new ZipError("Not a ZIP archive");
}

/** Lists the archive's file entries (directories are skipped). */
export function listZip(buf: Buffer, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipEntry[] {
  if (buf.length < 22) throw new ZipError("Not a ZIP archive");
  const eocd = findEocd(buf);
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError("ZIP64 archives are not supported");
  if (total > limits.maxEntries) throw new ZipError("Too many files in archive");
  if (cdOffset + cdSize > buf.length) throw new ZipError("Corrupt ZIP archive");

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  let totalSize = 0;
  for (let i = 0; i < total; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ZipError("Corrupt ZIP central directory");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString(flags & 0x800 ? "utf8" : "latin1", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/")) continue;
    if (flags & 0x1) throw new ZipError("Encrypted archives are not supported");
    if (method !== 0 && method !== 8) throw new ZipError(`Unsupported compression method ${method}`);
    if (size > limits.maxEntrySize) throw new ZipError(`File too large in archive: ${name}`);
    totalSize += size;
    if (totalSize > limits.maxTotalSize) throw new ZipError("Archive is too large when extracted");
    entries.push({ name, method, compressedSize, size, crc, localOffset });
  }
  return entries;
}

/** Extracts one entry's bytes, verifying size and CRC. */
export function readZipEntry(buf: Buffer, entry: ZipEntry): Buffer {
  const p = entry.localOffset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== 0x04034b50) throw new ZipError("Corrupt ZIP local header");
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const end = start + entry.compressedSize;
  if (end > buf.length) throw new ZipError("Corrupt ZIP entry");
  const raw = buf.subarray(start, end);
  let out: Buffer;
  if (entry.method === 0) {
    out = Buffer.from(raw);
  } else {
    try {
      out = inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size) });
    } catch {
      throw new ZipError(`Could not decompress ${entry.name}`);
    }
  }
  if (out.length !== entry.size) throw new ZipError(`Size mismatch for ${entry.name}`);
  if (crc32(out) !== entry.crc) throw new ZipError(`Checksum mismatch for ${entry.name}`);
  return out;
}
