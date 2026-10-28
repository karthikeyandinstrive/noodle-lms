import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { listZip, readZipEntry } from "../interactive/zip";
import { createZip, ZipWriter } from "./zip-writer";

function unzip(buf: Buffer) {
  return new Map(listZip(buf).map((e) => [e.name, readZipEntry(buf, e)]));
}

describe("zip writer", () => {
  it("round-trips text, binary, empty and unicode entries through the reader", () => {
    const binary = randomBytes(5000);
    const text = "hello ".repeat(2000);
    const zip = createZip([
      { name: "manifest.json", data: JSON.stringify({ a: 1 }) },
      { name: "files/abc/photo.bin", data: binary },
      { name: "big.txt", data: text },
      { name: "empty.txt", data: "" },
      { name: "dir/ñandú €.txt", data: "unicode ✓" },
      { name: "stored.txt", data: "not compressed", compress: false },
    ]);
    const out = unzip(zip);
    expect(out.size).toBe(6);
    expect(JSON.parse(out.get("manifest.json")!.toString())).toEqual({ a: 1 });
    expect(out.get("files/abc/photo.bin")!.equals(binary)).toBe(true);
    expect(out.get("big.txt")!.toString()).toBe(text);
    expect(out.get("empty.txt")!.length).toBe(0);
    expect(out.get("dir/ñandú €.txt")!.toString()).toBe("unicode ✓");
    expect(out.get("stored.txt")!.toString()).toBe("not compressed");
  });

  it("compresses repetitive data and stores incompressible data", () => {
    const text = "a".repeat(100_000);
    const zip = createZip([{ name: "a.txt", data: text }]);
    expect(zip.length).toBeLessThan(2000);
    const entries = listZip(zip);
    expect(entries[0]!.method).toBe(8);
    const rnd = randomBytes(2000);
    expect(listZip(createZip([{ name: "r", data: rnd }]))[0]!.method).toBe(0);
  });

  it("rejects unsafe and duplicate names", () => {
    expect(() => createZip([{ name: "../evil", data: "x" }])).toThrow();
    expect(() => createZip([{ name: "/abs", data: "x" }])).toThrow();
    const w = new ZipWriter().add({ name: "a", data: "1" });
    expect(() => w.add({ name: "a", data: "2" })).toThrow();
  });

  it("writes a valid empty archive", () => {
    expect(listZip(createZip([]))).toEqual([]);
  });
});
