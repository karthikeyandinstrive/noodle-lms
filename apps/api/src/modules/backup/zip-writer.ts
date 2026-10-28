import { deflateRawSync } from "node:zlib";
import { crc32, safeEntryPath } from "../interactive/zip";

/**
 * Minimal, dependency-free ZIP writer (the counterpart of interactive/zip.ts).
 *
 * Writes stored (0) or deflate (8) entries with UTF-8 names, a central directory
 * and the end-of-central-directory record. No ZIP64: the archive must stay under
 * 4 GiB and 65 535 entries, which is far above the backup size limit.
 */

export type ZipInput = { name: string; data: Buffer | string; /** default true: deflate when it saves space */ compress?: boolean; date?: Date };

const MAX_U32 = 0xffffffff;

function dosDateTime(d: Date) {
  const year = Math.max(1980, d.getFullYear());
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time: time & 0xffff, date: date & 0xffff };
}

export class ZipWriter {
  private chunks: Buffer[] = [];
  private central: Buffer[] = [];
  private offset = 0;
  private names = new Set<string>();

  get size() {
    return this.offset;
  }

  get count() {
    return this.names.size;
  }

  add(entry: ZipInput) {
    const name = safeEntryPath(entry.name);
    if (!name || name !== entry.name) throw new Error(`Invalid entry name: ${entry.name}`);
    if (this.names.has(name)) throw new Error(`Duplicate entry: ${name}`);
    if (this.names.size >= 0xfffe) throw new Error("Too many entries for a ZIP archive");
    const data = typeof entry.data === "string" ? Buffer.from(entry.data, "utf8") : entry.data;
    const crc = crc32(data);
    let method = 0;
    let body = data;
    if (entry.compress !== false && data.length > 0) {
      const deflated = deflateRawSync(data, { level: 6 });
      if (deflated.length < data.length) {
        method = 8;
        body = deflated;
      }
    }
    const nameBuf = Buffer.from(name, "utf8");
    const { time, date } = dosDateTime(entry.date ?? new Date());
    if (this.offset + 30 + nameBuf.length + body.length > MAX_U32) throw new Error("Archive too large (ZIP64 is not supported)");

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    // extra len, comment len, disk start, internal attrs = 0
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(this.offset, 42);

    this.chunks.push(local, nameBuf, body);
    this.central.push(cd, nameBuf);
    this.offset += local.length + nameBuf.length + body.length;
    this.names.add(name);
    return this;
  }

  /** Returns the complete archive. The writer should not be reused afterwards. */
  finish(): Buffer {
    const cdBuf = Buffer.concat(this.central);
    if (this.offset + cdBuf.length > MAX_U32) throw new Error("Archive too large (ZIP64 is not supported)");
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(this.names.size, 8);
    eocd.writeUInt16LE(this.names.size, 10);
    eocd.writeUInt32LE(cdBuf.length, 12);
    eocd.writeUInt32LE(this.offset, 16);
    eocd.writeUInt16LE(0, 20);
    return Buffer.concat([...this.chunks, cdBuf, eocd]);
  }
}

/** Builds a ZIP archive from a list of entries. */
export function createZip(entries: ZipInput[]): Buffer {
  const w = new ZipWriter();
  for (const e of entries) w.add(e);
  return w.finish();
}
