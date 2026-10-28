/**
 * Plain-text helpers for HTML content (word counts, emptiness checks, and
 * plain-text previews).
 */
export function htmlToPlain(html: string | null | undefined) {
  if (!html) return "";
  const withBreaks = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*/gi, "\n\n")
    .replace(/<[^>]+>/g, "");
  if (typeof document === "undefined") return withBreaks.trim();
  const el = document.createElement("textarea");
  el.innerHTML = withBreaks; // decodes entities without executing anything
  return el.value.trim();
}

export function wordCount(text: string) {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}
