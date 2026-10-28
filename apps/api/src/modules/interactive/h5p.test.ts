import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { inspectH5p, safeRequestPath } from "./h5p";
import { crc32, listZip, readZipEntry, safeEntryPath } from "./zip";

/** Minimal ZIP writer for fixtures (stored + deflate). */
function makeZip(entries: { name: string; data: string | Buffer; deflate?: boolean }[]) {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const comp = e.deflate ? deflateRawSync(data) : data;
    const name = Buffer.from(e.name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(e.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, comp);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(e.deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const h5pJson = JSON.stringify({ title: "Quiz", mainLibrary: "H5P.MultiChoice", language: "en" });

describe("zip reader", () => {
  it("reads stored and deflated entries", () => {
    const zip = makeZip([
      { name: "a.txt", data: "hello" },
      { name: "dir/b.json", data: JSON.stringify({ x: "y".repeat(1000) }), deflate: true },
    ]);
    const entries = listZip(zip);
    expect(entries.map((e) => e.name)).toEqual(["a.txt", "dir/b.json"]);
    expect(readZipEntry(zip, entries[0]!).toString()).toBe("hello");
    expect(JSON.parse(readZipEntry(zip, entries[1]!).toString()).x).toHaveLength(1000);
  });

  it("detects corruption and enforces limits", () => {
    const zip = makeZip([{ name: "a.txt", data: "hello" }]);
    const bad = Buffer.from(zip);
    bad[30 + 5] = "X".charCodeAt(0); // flip a data byte → CRC mismatch
    expect(() => readZipEntry(bad, listZip(bad)[0]!)).toThrow(/Checksum/);
    expect(() => listZip(Buffer.from("not a zip at all, definitely not"))).toThrow();
    expect(() => listZip(zip, { maxEntries: 10, maxEntrySize: 2, maxTotalSize: 100 })).toThrow(/too large/);
  });

  it("rejects unsafe paths", () => {
    expect(safeEntryPath("../etc/passwd")).toBeNull();
    expect(safeEntryPath("/abs/path")).toBeNull();
    expect(safeEntryPath("a/../../b")).toBeNull();
    expect(safeEntryPath("C:/x")).toBeNull();
    expect(safeEntryPath("a\\b")).toBeNull();
    expect(safeEntryPath("./content/content.json")).toBe("content/content.json");
  });
});

describe("inspectH5p", () => {
  it("validates a package and filters files by extension", () => {
    const zip = makeZip([
      { name: "h5p.json", data: h5pJson },
      { name: "content/content.json", data: "{}", deflate: true },
      { name: "H5P.MultiChoice-1.16/library.json", data: "{}" },
      { name: "H5P.MultiChoice-1.16/js/mc.js", data: "var x;" },
      { name: "evil.php", data: "<?php" },
      { name: "__MACOSX/._h5p.json", data: "x" },
    ]);
    const { meta, files } = inspectH5p(zip);
    expect(meta).toEqual({ title: "Quiz", mainLibrary: "H5P.MultiChoice", language: "en" });
    expect(files.map((f) => f.path).sort()).toEqual(["H5P.MultiChoice-1.16/js/mc.js", "H5P.MultiChoice-1.16/library.json", "content/content.json", "h5p.json"]);
  });

  it("requires h5p.json and content.json", () => {
    expect(() => inspectH5p(makeZip([{ name: "content/content.json", data: "{}" }]))).toThrow(/h5p.json/);
    expect(() => inspectH5p(makeZip([{ name: "h5p.json", data: h5pJson }]))).toThrow(/content.json/);
    expect(() => inspectH5p(makeZip([{ name: "h5p.json", data: "{" }, { name: "content/content.json", data: "{}" }]))).toThrow(/valid JSON/);
  });

  it("rejects zip-slip entries", () => {
    expect(() => inspectH5p(makeZip([{ name: "../h5p.json", data: h5pJson }]))).toThrow(/Unsafe/);
  });

  it("validates requested package paths", () => {
    expect(safeRequestPath("content/content.json")).toBe("content/content.json");
    expect(safeRequestPath("H5P.X-1.0/styles/a%20b.css")).toBe("H5P.X-1.0/styles/a b.css");
    expect(safeRequestPath("..%2Fsecret.json")).toBeNull();
    expect(safeRequestPath("index.html")).toBeNull();
    expect(safeRequestPath(".env.json")).toBeNull();
  });
});
