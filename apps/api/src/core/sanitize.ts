import sanitizeHtml from "sanitize-html";

/**
 * Sanitizes user-authored rich text (pages, forum posts, feedback) before
 * storing it. React escapes text, but this HTML is rendered as HTML.
 */
export function cleanHtml(html: string) {
  return sanitizeHtml(html, {
    allowedTags: [
      ...sanitizeHtml.defaults.allowedTags,
      "img",
      "h1",
      "h2",
      "span",
      "figure",
      "figcaption",
      "video",
      "source",
    ],
    allowedAttributes: {
      a: ["href", "name", "target", "rel"],
      img: ["src", "alt", "width", "height"],
      video: ["src", "controls", "width", "height"],
      source: ["src", "type"],
      span: ["style"],
      "*": ["class"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedStyles: { span: { color: [/^#[0-9a-f]{3,6}$/i], "font-weight": [/^bold$/] } },
    transformTags: { a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer" }) },
  });
}
