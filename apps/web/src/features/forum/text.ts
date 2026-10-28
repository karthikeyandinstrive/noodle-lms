/**
 * Plain-text <-> simple HTML helpers for the textarea editors used by the
 * forum and workshop UIs. The API sanitizes everything on write.
 */

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Paragraphs on blank lines, <br> on single newlines; bare URLs become links. */
export function textToHtml(text: string) {
  return text
    .trim()
    .split(/\n{2,}/)
    .map((p) => {
      const linked = escape(p).replace(/\bhttps?:\/\/[^\s<]+/g, (url) => `<a href="${url}" target="_blank">${url}</a>`);
      return `<p>${linked.replace(/\n/g, "<br>")}</p>`;
    })
    .join("");
}

/** Best-effort conversion of stored HTML back into editable text. */
export function htmlToText(html: string | null | undefined) {
  if (!html) return "";
  const withBreaks = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h\d|li|blockquote)>\s*/gi, "\n\n")
    .replace(/<li[^>]*>/gi, "• ");
  if (typeof DOMParser === "undefined") return withBreaks.replace(/<[^>]*>/g, "").trim();
  const doc = new DOMParser().parseFromString(withBreaks, "text/html");
  return (doc.body.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
}
