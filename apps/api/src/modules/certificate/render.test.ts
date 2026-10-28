import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { renderCertificatePdf } from "./pdf";
import { lineLeft, mmToPt, pageSizeMm, parseHexColor, renderPlaceholders, toEncodable, wrapText } from "./render";

const values = { fullname: "Ada Lovelace", coursename: "Analytical Engines", date: "October 28, 2026", code: "ABCD-EFGH-JKLM", grade: "95%", orgname: "Acme" };

describe("renderPlaceholders", () => {
  it("replaces known placeholders, tolerating spaces and case", () => {
    expect(renderPlaceholders("This certifies {{fullname}} completed {{ coursename }} on {{DATE}}", values)).toBe(
      "This certifies Ada Lovelace completed Analytical Engines on October 28, 2026",
    );
    expect(renderPlaceholders("{{code}} · {{grade}} · {{orgname}}", values)).toBe("ABCD-EFGH-JKLM · 95% · Acme");
  });
  it("leaves unknown placeholders untouched", () => {
    expect(renderPlaceholders("Hi {{nickname}}", values)).toBe("Hi {{nickname}}");
  });
  it("does not re-expand placeholders inside values", () => {
    expect(renderPlaceholders("{{fullname}}", { fullname: "{{code}}", code: "X" })).toBe("{{code}}");
  });
});

describe("layout helpers", () => {
  it("converts A4 mm to points", () => {
    expect(mmToPt(25.4)).toBeCloseTo(72);
    expect(pageSizeMm("landscape")).toEqual({ width: 297, height: 210 });
    expect(pageSizeMm("portrait")).toEqual({ width: 210, height: 297 });
  });
  it("aligns lines within a box or around an anchor", () => {
    expect(lineLeft({ x: 10, width: 100, align: "center" }, 20)).toBe(50);
    expect(lineLeft({ x: 10, width: 100, align: "right" }, 20)).toBe(90);
    expect(lineLeft({ x: 148.5, align: "center" }, 20)).toBe(138.5);
    expect(lineLeft({ x: 10 }, 20)).toBe(10);
  });
  it("wraps words to a width", () => {
    expect(wrapText("aa bb cc", 5, (s) => s.length)).toEqual(["aa bb", "cc"]);
    expect(wrapText("one\ntwo", null, (s) => s.length)).toEqual(["one", "two"]);
  });
  it("parses colors", () => {
    expect(parseHexColor("#fff")).toEqual({ r: 1, g: 1, b: 1 });
    expect(parseHexColor("#ff0000")).toEqual({ r: 1, g: 0, b: 0 });
    expect(parseHexColor("nope")).toEqual({ r: 0.1, g: 0.1, b: 0.1 });
  });
  it("maps unsupported characters for standard fonts", () => {
    const latin = new Set([..."Zoe Dvorak?é".split("").map((c) => c.codePointAt(0)!)]);
    expect(toEncodable("Zoé Dvořák", latin)).toBe("Zoé Dvorak");
    expect(toEncodable("李", latin)).toBe("?");
  });
});

describe("renderCertificatePdf", () => {
  it("produces a one-page A4 landscape PDF with text and a QR code", async () => {
    const pdf = await renderCertificatePdf({
      orientation: "landscape",
      elements: [
        { type: "text", x: 148.5, y: 40, fontSize: 36, align: "center", text: "Certificate of completion" },
        { type: "text", x: 20, y: 90, width: 257, fontSize: 18, align: "center", color: "#334155", text: "{{fullname}} — {{coursename}} (Zoë 李)" },
        { type: "qrcode", x: 250, y: 160, width: 30 },
      ],
      values,
      verifyUrl: "https://lms.example.com/verify/ABCD-EFGH-JKLM",
    });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBe(1);
    const { width, height } = doc.getPage(0).getSize();
    expect(width).toBeCloseTo(mmToPt(297));
    expect(height).toBeCloseTo(mmToPt(210));
  });
});
