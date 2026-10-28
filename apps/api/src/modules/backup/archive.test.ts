import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { ArchiveError, readArchive, readTar } from "./archive";
import { parseXml, path, textOf, XmlError } from "./xml";
import { createZip } from "./zip-writer";

function tarEntry(name: string, data: string | Buffer, type = "0") {
  const body = typeof data === "string" ? Buffer.from(data) : data;
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0, "utf8");
  h.write("0000644\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(body.length.toString(8).padStart(11, "0") + "\0", 124);
  h.write("00000000000\0", 136);
  h.write("        ", 148);
  h.write(type, 156);
  h.write("ustar\0", 257);
  h.write("00", 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return Buffer.concat([h, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}

const tar = (...parts: Buffer[]) => Buffer.concat([...parts, Buffer.alloc(1024)]);

describe("archive reader", () => {
  it("reads tar.gz with GNU long names and skips unsafe paths", () => {
    const long = `activities/${"x".repeat(120)}/page.xml`;
    const buf = gzipSync(
      tar(
        tarEntry("moodle_backup.xml", "<a/>"),
        tarEntry("dir/", "", "5"),
        tarEntry("././@LongLink", long + "\0", "L"),
        tarEntry("ignored", "<page/>"),
        tarEntry("../evil", "x"),
      ),
    );
    const files = readArchive(buf);
    expect([...files.keys()].sort()).toEqual([long, "moodle_backup.xml"].sort());
    expect(files.get(long)!.toString()).toBe("<page/>");
  });

  it("reads zip archives and rejects unknown formats", () => {
    const files = readArchive(createZip([{ name: "a.txt", data: "A" }]));
    expect(files.get("a.txt")!.toString()).toBe("A");
    expect(() => readArchive(Buffer.from("plain text"))).toThrow(ArchiveError);
  });

  it("enforces size limits", () => {
    const buf = tar(tarEntry("big", Buffer.alloc(2000)));
    expect(() => readTar(buf, { maxEntries: 10, maxEntrySize: 1000, maxTotalSize: 10_000 })).toThrow(/too large/);
  });
});

describe("xml parser", () => {
  it("parses elements, attributes, entities, CDATA and Moodle nulls", () => {
    const doc = parseXml(`<?xml version="1.0"?>
      <!-- c --><activity id="7" name='a &amp; b'><page><name>Intro &lt;1&gt; &#233;</name><content><![CDATA[<p>Hi</p>]]></content><x>$@NULL@$</x><e/></page></activity>`);
    const act = path(doc, "activity")!;
    expect(act.attrs).toEqual({ id: "7", name: "a & b" });
    const page = path(doc, "activity", "page");
    expect(textOf(page, "name")).toBe("Intro <1> é");
    expect(textOf(page, "content")).toBe("<p>Hi</p>");
    expect(textOf(page, "x")).toBeNull();
    expect(textOf(page, "e")).toBe("");
  });

  it("rejects DOCTYPE/entities and malformed documents", () => {
    expect(() => parseXml(`<!DOCTYPE x [<!ENTITY a "b">]><x>&a;</x>`)).toThrow(XmlError);
    expect(() => parseXml(`<a><b></a>`)).toThrow(XmlError);
    expect(() => parseXml(`<a>`)).toThrow(XmlError);
  });
});
