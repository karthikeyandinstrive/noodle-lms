/**
 * Pure certificate layout helpers shared by the PDF renderer and tests.
 * Coordinates are millimetres from the top-left corner of an A4 page.
 */

export const PLACEHOLDERS = ["fullname", "coursename", "date", "code", "grade", "orgname"] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];
export type CertificateValues = Record<Placeholder, string>;

export const A4 = { short: 210, long: 297 } as const;
export const MM_TO_PT = 72 / 25.4;
export const mmToPt = (mm: number) => mm * MM_TO_PT;

export function pageSizeMm(orientation: string) {
  return orientation === "portrait" ? { width: A4.short, height: A4.long } : { width: A4.long, height: A4.short };
}

/** Replaces {{placeholder}} tokens. Unknown tokens are left untouched so typos are visible. */
export function renderPlaceholders(text: string, values: Partial<Record<string, string>>) {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (match, key: string) => {
    const v = values[key.toLowerCase()];
    return v === undefined ? match : v;
  });
}

/** Text at/above this size renders bold (mirrored by the web preview). */
export const BOLD_FROM_PT = 24;

/** Parses #rgb / #rrggbb into 0..1 components (defaults to near-black). */
export function parseHexColor(hex: string | undefined) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex ?? "");
  if (!m) return { r: 0.1, g: 0.1, b: 0.1 };
  let h = m[1]!;
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = Number.parseInt(h, 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

/**
 * Maps text to characters the standard PDF fonts (WinAnsi) can encode: keeps
 * supported characters, strips diacritics where that helps, otherwise "?".
 */
export function toEncodable(text: string, supported: Set<number>) {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (ch === "\n" || supported.has(cp)) {
      out += ch;
      continue;
    }
    const folded = ch.normalize("NFKD").replace(/[̀-ͯ]/g, "");
    out += folded && [...folded].every((c) => supported.has(c.codePointAt(0)!)) ? folded : "?";
  }
  return out;
}

/** Greedy word wrap; `measure` returns the width of a string in the same unit as maxWidth. */
export function wrapText(text: string, maxWidth: number | null, measure: (s: string) => number) {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    if (!maxWidth) {
      lines.push(para);
      continue;
    }
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (!line || measure(candidate) <= maxWidth) line = candidate;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** Left edge (mm) of a line of text given the element's anchor/box and alignment. */
export function lineLeft(el: { x: number; width?: number; align?: "left" | "center" | "right" }, lineWidthMm: number) {
  const align = el.align ?? "left";
  if (el.width) {
    if (align === "center") return el.x + (el.width - lineWidthMm) / 2;
    if (align === "right") return el.x + el.width - lineWidthMm;
    return el.x;
  }
  if (align === "center") return el.x - lineWidthMm / 2;
  if (align === "right") return el.x - lineWidthMm;
  return el.x;
}
