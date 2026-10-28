import { describe, expect, it } from "vitest";
import { isInlineMime, normalizeExternalUrl, parseOptions } from "./options";

describe("normalizeExternalUrl", () => {
  it("accepts http and https", () => {
    expect(normalizeExternalUrl(" https://example.com/a?b=1 ")).toBe("https://example.com/a?b=1");
    expect(normalizeExternalUrl("http://example.com")).toBe("http://example.com/");
  });
  it("rejects dangerous or malformed URLs", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "ftp://x.org", "not a url", "", "https://user:pw@example.com", "//example.com"]) {
      expect(normalizeExternalUrl(bad)).toBeNull();
    }
    expect(normalizeExternalUrl(`https://e.com/${"a".repeat(2100)}`)).toBeNull();
  });
});

describe("parseOptions", () => {
  it("falls back to defaults and ignores wrong types", () => {
    expect(parseOptions(null, { openInNewTab: true })).toEqual({ openInNewTab: true });
    expect(parseOptions("<p>html</p>", { openInNewTab: true })).toEqual({ openInNewTab: true });
    expect(parseOptions('{"openInNewTab":"no","x":1}', { openInNewTab: true })).toEqual({ openInNewTab: true });
    expect(parseOptions('{"display":"download"}', { display: "inline" })).toEqual({ display: "download" });
  });
});

describe("isInlineMime", () => {
  it("allows safe previewable types only", () => {
    expect(isInlineMime("application/pdf")).toBe(true);
    expect(isInlineMime("image/png")).toBe(true);
    expect(isInlineMime("video/mp4")).toBe(true);
    expect(isInlineMime("image/svg+xml")).toBe(false);
    expect(isInlineMime("text/html")).toBe(false);
  });
});
