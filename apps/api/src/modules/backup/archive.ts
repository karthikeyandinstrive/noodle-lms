import { gunzipSync } from "node:zlib";
import { DEFAULT_ZIP_LIMITS, listZip, readZipEntry, safeEntryPath, ZipError, type ZipLimits } from "../interactive/zip";

/**
 * Reads backup archives into memory as `path → bytes`:
 *  - ZIP (our .zip backups, and zipped Moodle .mbz files)
 *  - gzip-compressed tar (the default Moodle .mbz format), via a tiny tar reader.
 * Entry names are normalized with `safeEntryPath`; unsafe names are skipped.
 */

export class ArchiveError extends Error {}

export type ArchiveFiles = Map<string, Buffer>;

export const ARCHIVE_LIMITS: ZipLimits = {
  maxEntries: 50_000,
  maxEntrySize: 200 * 1024 * 1024,
  maxTotalSize: 1024 * 1024 * 1024,
};

export function isZip(buf: Buffer) {
  return buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50;
}

export function isGzip(buf: Buffer) {
  return buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

export function readZipArchive(buf: Buffer, limits: ZipLimits = ARCHIVE_LIMITS, only?: (name: string) => boolean): ArchiveFiles {
  const out: ArchiveFiles = new Map();
  try {
    for (const e of listZip(buf, limits)) {
      const name = safeEntryPath(e.name);
      if (!name || (only && !only(name))) continue;
      out.set(name, readZipEntry(buf, e));
    }
  } catch (err) {
    throw new ArchiveError(err instanceof ZipError ? err.message : "Corrupt ZIP archive");
  }
  return out;
}

function octal(buf: Buffer, start: number, len: number) {
  const s = buf.toString("latin1", start, start + len).replace(/\0.*$/, "").trim();
  if (!s) return 0;
  // GNU base-256 encoding for big sizes.
  if (buf[start]! & 0x80) throw new ArchiveError("Tar entries over 8 GiB are not supported");
  const n = parseInt(s, 8);
  if (!Number.isFinite(n)) throw new ArchiveError("Corrupt tar header");
  return n;
}

function cstring(buf: Buffer, start: number, len: number) {
  const raw = buf.subarray(start, start + len);
  const end = raw.indexOf(0);
  return raw.toString("utf8", 0, end < 0 ? len : end);
}

function paxPath(data: Buffer) {
  // Records: "<len> key=value\n"
  let p = 0;
  let path: string | null = null;
  while (p < data.length) {
    const sp = data.indexOf(0x20, p);
    if (sp < 0) break;
    const len = parseInt(data.toString("latin1", p, sp), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const rec = data.toString("utf8", sp + 1, p + len - 1);
    const eq = rec.indexOf("=");
    if (eq > 0 && rec.slice(0, eq) === "path") path = rec.slice(eq + 1);
    p += len;
  }
  return path;
}

/** Parses an (uncompressed) tar archive. Only regular files are returned. */
export function readTar(tar: Buffer, limits: ZipLimits = ARCHIVE_LIMITS, only?: (name: string) => boolean): ArchiveFiles {
  const out: ArchiveFiles = new Map();
  let p = 0;
  let longName: string | null = null;
  let total = 0;
  let count = 0;
  while (p + 512 <= tar.length) {
    const header = tar.subarray(p, p + 512);
    if (header.every((b) => b === 0)) break; // end-of-archive marker
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 0x30);
    let name = cstring(header, 0, 100);
    if (header.toString("latin1", 257, 262) === "ustar") {
      const prefix = cstring(header, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    const dataStart = p + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new ArchiveError("Truncated tar archive");
    const data = tar.subarray(dataStart, dataEnd);
    p = dataStart + Math.ceil(size / 512) * 512;

    if (type === "L") {
      longName = cstring(data, 0, data.length);
      continue;
    }
    if (type === "x") {
      longName = paxPath(data) ?? longName;
      continue;
    }
    if (type === "g") continue;
    if (longName) {
      name = longName;
      longName = null;
    }
    if (type !== "0" && type !== "\0" && type !== "7") continue; // dirs, links, devices…
    if (++count > limits.maxEntries) throw new ArchiveError("Too many files in archive");
    if (size > limits.maxEntrySize) throw new ArchiveError(`File too large in archive: ${name}`);
    total += size;
    if (total > limits.maxTotalSize) throw new ArchiveError("Archive is too large when extracted");
    const safe = safeEntryPath(name);
    if (!safe || (only && !only(safe))) continue;
    out.set(safe, Buffer.from(data));
  }
  return out;
}

/** Reads a ZIP or a .tar.gz archive. */
export function readArchive(buf: Buffer, limits: ZipLimits = ARCHIVE_LIMITS, only?: (name: string) => boolean): ArchiveFiles {
  if (isZip(buf)) return readZipArchive(buf, limits, only);
  if (isGzip(buf)) {
    let tar: Buffer;
    try {
      tar = gunzipSync(buf, { maxOutputLength: limits.maxTotalSize + 1024 * 1024 });
    } catch {
      throw new ArchiveError("Could not decompress the archive (or it is too large)");
    }
    return readTar(tar, limits, only);
  }
  throw new ArchiveError("Unsupported archive: upload a .zip backup or a Moodle .mbz file");
}

export { DEFAULT_ZIP_LIMITS };
