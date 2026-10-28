/**
 * Pure helpers for content resources (no DB / config imports, so they are unit-testable).
 *
 * `content_resources` has no settings column: for "url" and "file" activities the
 * `content` column stores a small JSON options object (pages store sanitized HTML there).
 */

export type UrlOptions = { openInNewTab: boolean };
export type FileOptions = { display: "download" | "inline" };

/**
 * Validates an external link: http(s) only, no embedded credentials, max 2000 chars.
 * Returns the normalized href or null when invalid. Never fetched server-side.
 */
export function normalizeExternalUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw || raw.length > 2000) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (!url.hostname) return null;
  return url.href;
}

export function parseOptions<T extends object>(raw: string | null | undefined, defaults: T): T {
  if (!raw) return { ...defaults };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...defaults };
    const out = { ...defaults } as Record<string, unknown>;
    for (const key of Object.keys(defaults)) {
      const v = (parsed as Record<string, unknown>)[key];
      if (v !== undefined && typeof v === typeof (defaults as Record<string, unknown>)[key]) out[key] = v;
    }
    return out as T;
  } catch {
    return { ...defaults };
  }
}

/** MIME types the browser can safely render inline from a signed URL. */
export function isInlineMime(mime: string) {
  return mime === "application/pdf" || /^image\/(png|jpeg|gif|webp)$/.test(mime) || /^video\/(mp4|webm)$/.test(mime) || /^audio\//.test(mime);
}
