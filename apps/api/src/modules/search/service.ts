import { sql, type SQL } from "drizzle-orm";

/** Queries shorter than this use ILIKE only (full-text search ignores very short terms). */
export const FTS_MIN_LENGTH = 3;

/** Escapes LIKE wildcards in user input. */
export function likeEscape(value: string) {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/** Strips tags and entities from sanitized HTML. */
export function stripHtml(html: string | null | undefined) {
  if (!html) return "";
  return html
    .replace(/<(br|\/p|\/div|\/li|\/h\d)[^>]*>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Plain-text snippet around the first occurrence of any query term
 * (the client highlights matches itself, so no HTML is returned).
 */
export function snippet(text: string | null | undefined, query: string, radius = 80) {
  const plain = stripHtml(text);
  if (!plain) return "";
  const lower = plain.toLowerCase();
  const terms = query
    .toLowerCase()
    .replace(/["()]/g, " ")
    .split(/\s+/)
    .filter((t) => t && t !== "or" && !t.startsWith("-"));
  let at = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return plain.length > radius * 2 ? `${plain.slice(0, radius * 2 - 1)}…` : plain;
  const start = Math.max(0, at - radius);
  const end = Math.min(plain.length, at + radius);
  return `${start > 0 ? "…" : ""}${plain.slice(start, end).trim()}${end < plain.length ? "…" : ""}`;
}

/**
 * Text match condition: Postgres full-text search (`simple` config, so it works
 * for any language) OR a case-insensitive substring match on the title columns
 * (gives prefix matches like "alg" → "Algebra"). Short queries use ILIKE only.
 */
export function textMatch(query: string, titleCols: SQL[], bodyCols: SQL[]): SQL {
  const like = `%${likeEscape(query)}%`;
  const likes = [...titleCols, ...(query.length < FTS_MIN_LENGTH ? bodyCols : [])].map((c) => sql`${c} ilike ${like}`);
  if (query.length < FTS_MIN_LENGTH) return sql`(${sql.join(likes, sql` or `)})`;
  const fts = sql`${documentOf([...titleCols, ...bodyCols])} @@ websearch_to_tsquery('simple', ${query})`;
  if (!likes.length) return fts;
  return sql`(${fts} or ${sql.join(likes, sql` or `)})`;
}

/** Relevance score (0 for ILIKE-only matches). */
export function rank(query: string, cols: SQL[]): SQL<number> {
  // Not a bare "0": ORDER BY 0 would mean "column position 0".
  if (query.length < FTS_MIN_LENGTH) return sql<number>`0::real`;
  return sql<number>`ts_rank(${documentOf(cols)}, websearch_to_tsquery('simple', ${query}))`;
}

function documentOf(cols: SQL[]) {
  return sql`to_tsvector('simple', ${sql.join(
    cols.map((c) => sql`coalesce(${c}, '')`),
    sql` || ' ' || `,
  )})`;
}
