import { describe, expect, it } from "vitest";
import { normalizeEmbedUrl } from "./embed";

const url = (s: string) => normalizeEmbedUrl(s)?.url ?? null;

describe("normalizeEmbedUrl", () => {
  it("normalizes YouTube links to youtube-nocookie embeds", () => {
    expect(url("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m5s")).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=65");
    expect(url("https://youtu.be/dQw4w9WgXcQ")).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
    expect(url("https://youtube.com/shorts/dQw4w9WgXcQ")).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
    expect(url("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ")).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
    expect(url("https://www.youtube.com/playlist?list=PL1234567890")).toBe("https://www.youtube-nocookie.com/embed/videoseries?list=PL1234567890");
    expect(url("https://www.youtube.com/watch?v=bad")).toBeNull();
  });

  it("normalizes Vimeo", () => {
    expect(url("https://vimeo.com/76979871")).toBe("https://player.vimeo.com/video/76979871");
    expect(url("https://vimeo.com/76979871/abcdef1234")).toBe("https://player.vimeo.com/video/76979871?h=abcdef1234");
    expect(url("https://player.vimeo.com/video/76979871?h=abcdef1234&autoplay=1")).toBe("https://player.vimeo.com/video/76979871?h=abcdef1234");
  });

  it("accepts h5p.com and its subdomains", () => {
    expect(url("https://school.h5p.com/content/1291234567890")).toBe("https://school.h5p.com/content/1291234567890/embed");
    expect(url("https://h5p.com/content/12/embed")).toBe("https://h5p.com/content/12/embed");
    expect(url("https://evil.h5p.com.attacker.net/content/1")).toBeNull();
    expect(url("https://school.h5p.com/other")).toBeNull();
  });

  it("normalizes Google Docs, Slides, Sheets and Forms", () => {
    expect(url("https://docs.google.com/document/d/abc_DEF-123/edit")).toBe("https://docs.google.com/document/d/abc_DEF-123/preview");
    expect(url("https://docs.google.com/presentation/d/abc123/edit#slide=id.p")).toBe("https://docs.google.com/presentation/d/abc123/embed");
    expect(url("https://docs.google.com/spreadsheets/d/abc123/edit")).toBe("https://docs.google.com/spreadsheets/d/abc123/preview");
    expect(url("https://docs.google.com/forms/d/e/1FAIpQL/viewform")).toBe("https://docs.google.com/forms/d/e/1FAIpQL/viewform?embedded=true");
    expect(url("https://docs.google.com/uc?export=download")).toBeNull();
  });

  it("normalizes Loom", () => {
    expect(url("https://www.loom.com/share/0123456789abcdef0123456789abcdef")).toBe("https://www.loom.com/embed/0123456789abcdef0123456789abcdef");
  });

  it("rejects everything else", () => {
    for (const bad of [
      "javascript:alert(1)",
      "https://example.com/video",
      "https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ",
      "https://user:pass@www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://www.youtube.com:8443/watch?v=dQw4w9WgXcQ",
      "data:text/html,<script>",
      "https://drive.google.com/file/d/x/view",
      "",
    ]) {
      expect(normalizeEmbedUrl(bad), bad).toBeNull();
    }
  });

  it("is idempotent on its own output (the web app relies on this)", () => {
    for (const input of [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30",
      "https://www.youtube.com/playlist?list=PL1234567890",
      "https://vimeo.com/76979871/abcdef1234",
      "https://school.h5p.com/content/1291234567890",
      "https://docs.google.com/document/d/abc/edit",
      "https://docs.google.com/spreadsheets/d/e/2PACX-1v/pubhtml",
      "https://docs.google.com/forms/d/e/1FAIpQL/viewform",
      "https://www.loom.com/share/0123456789abcdef0123456789abcdef",
    ]) {
      const once = url(input)!;
      expect(once).not.toBeNull();
      expect(url(once)).toBe(once);
    }
  });
});
