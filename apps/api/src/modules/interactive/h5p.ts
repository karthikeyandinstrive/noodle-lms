import { listZip, readZipEntry, safeEntryPath, ZipError, type ZipEntry } from "./zip";

/**
 * H5P package inspection (pure; storage I/O lives in service.ts).
 *
 * A .h5p file is a ZIP with `h5p.json` (metadata), `content/content.json` and one
 * folder per library (`<machineName>-<major>.<minor>/`). We validate the
 * structure, keep only files with H5P's whitelisted extensions, and the service
 * stores them under `<org>/interactive/h5p/<interactiveId>/<packageFileId>/…`.
 */

/** H5P core's default whitelist + library code (js/css). */
const ALLOWED_EXT = new Set(
  "json png jpg jpeg gif bmp tif tiff svg eot ttf woff woff2 otf webm mp4 ogg mp3 m4a wav txt pdf rtf doc docx xls xlsx ppt pptx odt ods odp xml csv diff patch md textile vtt webvtt js css".split(
    " ",
  ),
);

export type H5pMeta = { title: string; mainLibrary: string; language: string | null };
export type H5pFile = { path: string; entry: ZipEntry };

export class H5pError extends Error {}

export function extensionOf(path: string) {
  const i = path.lastIndexOf(".");
  return i < 0 ? "" : path.slice(i + 1).toLowerCase();
}

/** Validates the package and returns its metadata plus the files to extract. */
export function inspectH5p(zip: Buffer): { meta: H5pMeta; files: H5pFile[] } {
  let entries: ZipEntry[];
  try {
    entries = listZip(zip);
  } catch (err) {
    throw new H5pError(err instanceof ZipError ? err.message : "Invalid H5P package");
  }
  const files: H5pFile[] = [];
  for (const entry of entries) {
    const path = safeEntryPath(entry.name);
    if (!path) throw new H5pError(`Unsafe path in package: ${entry.name.slice(0, 100)}`);
    // Skip OS metadata and anything outside the whitelist (H5P core does the same).
    if (path.split("/").some((p) => p.startsWith(".") || p === "__MACOSX")) continue;
    if (!ALLOWED_EXT.has(extensionOf(path))) continue;
    files.push({ path, entry });
  }
  const h5pJson = files.find((f) => f.path === "h5p.json");
  if (!h5pJson) throw new H5pError("Not an H5P package: h5p.json is missing");
  if (!files.some((f) => f.path === "content/content.json")) throw new H5pError("Not an H5P package: content/content.json is missing");

  let parsed: unknown;
  try {
    parsed = JSON.parse(readZipEntry(zip, h5pJson.entry).toString("utf8"));
  } catch {
    throw new H5pError("h5p.json is not valid JSON");
  }
  const obj = (parsed ?? {}) as Record<string, unknown>;
  if (typeof obj.mainLibrary !== "string" || !/^[A-Za-z0-9._-]{1,100}$/.test(obj.mainLibrary)) {
    throw new H5pError("h5p.json has no valid mainLibrary");
  }
  const title = typeof obj.title === "string" ? obj.title.slice(0, 255) : "H5P content";
  const language = typeof obj.language === "string" ? obj.language.slice(0, 10) : null;
  return { meta: { title, mainLibrary: obj.mainLibrary, language }, files };
}

const MIME: Record<string, string> = {
  json: "application/json",
  js: "text/javascript",
  css: "text/css",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  svg: "image/svg+xml",
  eot: "application/vnd.ms-fontobject",
  ttf: "font/ttf",
  woff: "font/woff",
  woff2: "font/woff2",
  otf: "font/otf",
  webm: "video/webm",
  mp4: "video/mp4",
  ogg: "audio/ogg",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  txt: "text/plain",
  vtt: "text/vtt",
  webvtt: "text/vtt",
  pdf: "application/pdf",
  xml: "application/xml",
  csv: "text/csv",
  md: "text/plain",
};

export function mimeOf(path: string) {
  return MIME[extensionOf(path)] ?? "application/octet-stream";
}

/** Package-relative path requested by the player: validated against traversal and the whitelist. */
export function safeRequestPath(path: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  const safe = safeEntryPath(decoded);
  if (!safe || !ALLOWED_EXT.has(extensionOf(safe))) return null;
  if (safe.split("/").some((p) => p.startsWith("."))) return null;
  return safe;
}
