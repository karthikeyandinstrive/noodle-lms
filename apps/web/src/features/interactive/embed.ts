/* Mirror of apps/api/src/modules/interactive/embed.ts (client-side preview + defense in depth; the API is authoritative). */
export type EmbedProvider = "youtube" | "vimeo" | "h5p" | "google" | "loom";
export type NormalizedEmbed = { provider: EmbedProvider; url: string };

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const SAFE_ID = /^[A-Za-z0-9_-]{1,200}$/;

function hostIs(host: string, ...allowed: string[]) {
  return allowed.includes(host);
}

function startSeconds(u: URL): number | null {
  const t = u.searchParams.get("t") ?? u.searchParams.get("start");
  if (!t) return null;
  if (/^\d+$/.test(t)) return Number(t);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
  if (!m) return null;
  const s = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  return s > 0 ? s : null;
}

function youtube(u: URL, host: string): NormalizedEmbed | null {
  let id: string | null = null;
  const parts = u.pathname.split("/").filter(Boolean);
  if (host === "youtu.be") id = parts[0] ?? null;
  else if (parts[0] === "watch") id = u.searchParams.get("v");
  else if (["embed", "shorts", "live", "v"].includes(parts[0] ?? "")) id = parts[1] ?? null;
  else if (parts[0] === "playlist") {
    const list = u.searchParams.get("list");
    if (list && SAFE_ID.test(list)) return { provider: "youtube", url: `https://www.youtube-nocookie.com/embed/videoseries?list=${list}` };
    return null;
  }
  if (id === "videoseries" && host !== "youtu.be") {
    const list = u.searchParams.get("list");
    if (list && SAFE_ID.test(list)) return { provider: "youtube", url: `https://www.youtube-nocookie.com/embed/videoseries?list=${list}` };
    return null;
  }
  if (!id || !YT_ID.test(id)) return null;
  const start = startSeconds(u);
  return { provider: "youtube", url: `https://www.youtube-nocookie.com/embed/${id}${start ? `?start=${start}` : ""}` };
}

function vimeo(u: URL, host: string): NormalizedEmbed | null {
  const parts = u.pathname.split("/").filter(Boolean);
  let id: string | undefined;
  let hash: string | null = null;
  if (host === "player.vimeo.com") {
    if (parts[0] !== "video") return null;
    id = parts[1];
    hash = u.searchParams.get("h");
  } else {
    // vimeo.com/<id>, vimeo.com/<id>/<hash>, vimeo.com/channels/<x>/<id>
    const idx = parts.findIndex((p) => /^\d+$/.test(p));
    if (idx < 0) return null;
    id = parts[idx];
    const next = parts[idx + 1];
    if (next && /^[a-f0-9]{6,20}$/i.test(next)) hash = next;
    hash = hash ?? u.searchParams.get("h");
  }
  if (!id || !/^\d{1,15}$/.test(id)) return null;
  if (hash && !/^[a-f0-9]{6,20}$/i.test(hash)) hash = null;
  return { provider: "vimeo", url: `https://player.vimeo.com/video/${id}${hash ? `?h=${hash}` : ""}` };
}

function h5p(u: URL, host: string): NormalizedEmbed | null {
  const m = /^\/content\/(\d{1,25})(?:\/embed)?\/?$/.exec(u.pathname);
  if (!m) return null;
  return { provider: "h5p", url: `https://${host}/content/${m[1]}/embed` };
}

function google(u: URL): NormalizedEmbed | null {
  const parts = u.pathname.split("/").filter(Boolean);
  const kind = parts[0];
  if (!kind || !["document", "presentation", "spreadsheets", "forms"].includes(kind)) return null;
  if (parts[1] !== "d") return null;
  // Published ("/d/e/<id>/pub") vs regular ("/d/<id>/edit")
  const published = parts[2] === "e";
  const id = published ? parts[3] : parts[2];
  if (!id || !SAFE_ID.test(id)) return null;
  const base = `https://docs.google.com/${kind}/d/${published ? "e/" : ""}${id}`;
  switch (kind) {
    case "document":
      return { provider: "google", url: published ? `${base}/pub?embedded=true` : `${base}/preview` };
    case "presentation":
      return { provider: "google", url: `${base}/embed` };
    case "spreadsheets":
      return { provider: "google", url: published ? `${base}/pubhtml?widget=true&headers=false` : `${base}/preview` };
    case "forms":
      return { provider: "google", url: `${base}/viewform?embedded=true` };
  }
  return null;
}

function loom(u: URL): NormalizedEmbed | null {
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts[0] !== "share" && parts[0] !== "embed") return null;
  const id = parts[1];
  if (!id || !/^[A-Za-z0-9]{10,64}$/.test(id)) return null;
  return { provider: "loom", url: `https://www.loom.com/embed/${id}` };
}

/** Returns the canonical embed URL, or null if the link is not from an allow-listed provider. */
export function normalizeEmbedUrl(input: string): NormalizedEmbed | null {
  const raw = input.trim();
  if (!raw || raw.length > 2000) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();

  if (hostIs(host, "youtube.com", "www.youtube.com", "m.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com", "youtu.be")) {
    return youtube(u, host);
  }
  if (hostIs(host, "vimeo.com", "www.vimeo.com", "player.vimeo.com")) return vimeo(u, host);
  if (host === "h5p.com" || (host.endsWith(".h5p.com") && /^[a-z0-9-]+\.h5p\.com$/.test(host))) return h5p(u, host);
  if (host === "docs.google.com") return google(u);
  if (hostIs(host, "loom.com", "www.loom.com")) return loom(u);
  return null;
}

/** Only canonical embed URLs produced by the normalizer may be framed. */
export function isAllowedEmbedSrc(src: string) {
  const n = normalizeEmbedUrl(src);
  return !!n && n.url === src;
}
