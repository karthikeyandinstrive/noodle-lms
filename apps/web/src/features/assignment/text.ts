/**
 * Online text is edited as plain text and stored as minimal HTML (the API
 * sanitizes it again). These helpers convert between the two.
 */
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function plainToHtml(text: string) {
  const trimmed = text.replace(/\r\n/g, "\n").trim();
  if (!trimmed) return "";
  return trimmed
    .split(/\n{2,}/)
    .map((p) => `<p>${escape(p).replace(/\n/g, "<br />")}</p>`)
    .join("");
}

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
