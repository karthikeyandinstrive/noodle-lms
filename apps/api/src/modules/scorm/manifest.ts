/**
 * SCORM imsmanifest.xml parsing (pure, dependency-free).
 *
 * A deliberately small XML parser for the subset manifests use: elements, attributes,
 * text, CDATA, comments and processing instructions. It never resolves DTDs or custom
 * entities (no XXE / billion laughs): a DOCTYPE is skipped, only the five predefined
 * entities and numeric character references are decoded. Input size, depth and node
 * count are bounded.
 */

export type XmlNode = { name: string; local: string; attrs: Record<string, string>; children: XmlNode[]; text: string };

export class ManifestError extends Error {}

const LIMITS = { maxBytes: 2 * 1024 * 1024, maxDepth: 64, maxNodes: 50_000 };

const NAME = /[A-Za-z_][\w.:-]*/y;

function decodeEntities(s: string) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e: string) => {
    if (e === "amp") return "&";
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    if (e === "quot") return '"';
    if (e === "apos") return "'";
    const code = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

const localName = (name: string) => name.slice(name.indexOf(":") + 1);

export function parseXml(input: string): XmlNode {
  if (input.length > LIMITS.maxBytes) throw new ManifestError("imsmanifest.xml is too large");
  const s = input.replace(/^﻿/, "");
  const root: XmlNode = { name: "#document", local: "#document", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  let i = 0;
  let nodes = 0;

  const expect = (cond: boolean, msg: string) => {
    if (!cond) throw new ManifestError(`Invalid XML: ${msg}`);
  };
  const skipTo = (marker: string) => {
    const j = s.indexOf(marker, i);
    expect(j >= 0, `unterminated ${marker}`);
    i = j + marker.length;
  };

  while (i < s.length) {
    const lt = s.indexOf("<", i);
    const top = stack[stack.length - 1]!;
    if (lt < 0) {
      top.text += decodeEntities(s.slice(i));
      break;
    }
    if (lt > i) top.text += decodeEntities(s.slice(i, lt));
    i = lt;
    if (s.startsWith("<!--", i)) {
      skipTo("-->");
    } else if (s.startsWith("<![CDATA[", i)) {
      const j = s.indexOf("]]>", i);
      expect(j >= 0, "unterminated CDATA");
      top.text += s.slice(i + 9, j);
      i = j + 3;
    } else if (s.startsWith("<?", i)) {
      skipTo("?>");
    } else if (s.startsWith("<!", i)) {
      // DOCTYPE (possibly with an internal subset): skipped, never interpreted.
      let depth = 0;
      for (; i < s.length; i++) {
        if (s[i] === "[") depth++;
        else if (s[i] === "]") depth--;
        else if (s[i] === ">" && depth <= 0) break;
      }
      expect(i < s.length, "unterminated declaration");
      i++;
    } else if (s.startsWith("</", i)) {
      NAME.lastIndex = i + 2;
      const m = NAME.exec(s);
      expect(!!m, "bad closing tag");
      const name = m![0];
      i = NAME.lastIndex;
      while (/\s/.test(s[i] ?? "")) i++;
      expect(s[i] === ">", "bad closing tag");
      i++;
      expect(stack.length > 1 && top.name === name, `mismatched </${name}>`);
      stack.pop();
    } else {
      NAME.lastIndex = i + 1;
      const m = NAME.exec(s);
      expect(!!m, "bad tag");
      const name = m![0];
      i = NAME.lastIndex;
      const attrs: Record<string, string> = {};
      for (;;) {
        while (/\s/.test(s[i] ?? "")) i++;
        if (s[i] === ">" || s.startsWith("/>", i)) break;
        NAME.lastIndex = i;
        const a = NAME.exec(s);
        expect(!!a, `bad attribute in <${name}>`);
        i = NAME.lastIndex;
        while (/\s/.test(s[i] ?? "")) i++;
        expect(s[i] === "=", `attribute without value in <${name}>`);
        i++;
        while (/\s/.test(s[i] ?? "")) i++;
        const q = s[i];
        expect(q === '"' || q === "'", "unquoted attribute");
        const end = s.indexOf(q!, i + 1);
        expect(end >= 0, "unterminated attribute");
        attrs[a![0]] = decodeEntities(s.slice(i + 1, end));
        i = end + 1;
      }
      expect(++nodes <= LIMITS.maxNodes, "too many elements");
      const node: XmlNode = { name, local: localName(name), attrs, children: [], text: "" };
      top.children.push(node);
      if (s.startsWith("/>", i)) {
        i += 2;
      } else {
        i++;
        stack.push(node);
        expect(stack.length <= LIMITS.maxDepth, "nesting too deep");
      }
    }
  }
  expect(stack.length === 1, `unclosed <${stack[stack.length - 1]!.name}>`);
  const docEl = root.children[0];
  expect(!!docEl && root.children.length === 1, "expected one root element");
  return docEl!;
}

/** Attribute by local name (namespace prefixes vary: adlcp:scormtype, adlcp:scormType, …), case-insensitive. */
export function attr(node: XmlNode, local: string): string | undefined {
  const want = local.toLowerCase();
  for (const [k, v] of Object.entries(node.attrs)) if (localName(k).toLowerCase() === want) return v;
  return undefined;
}

const kids = (node: XmlNode | undefined, local: string) => (node ? node.children.filter((c) => c.local === local) : []);
const kid = (node: XmlNode | undefined, local: string) => kids(node, local)[0];
const textOf = (node: XmlNode | undefined): string => (node ? (node.text + node.children.map(textOf).join("")).trim() : "");

// ─── Manifest ───────────────────────────────────────────────────────────────

export type ScormVersion = "1.2" | "2004";

export type ManifestItem = { identifier: string; title: string; resourceId: string | null; href: string | null; isSco: boolean };

/** One launchable SCO, with the launch settings that apply to it. */
export type ScoInfo = {
  identifier: string;
  title: string;
  /** Package-relative launch path including item parameters (query/fragment). */
  href: string;
  masteryScore: number | null;
  scaledPassingScore: number | null;
  completionThreshold: number | null;
  launchData: string | null;
  maxTimeAllowed: string | null;
  timeLimitAction: string | null;
};

/** Most SCOs kept per package; larger packages are rejected. */
export const MAX_SCOS = 200;

export type ManifestInfo = {
  version: ScormVersion;
  schemaVersion: string | null;
  identifier: string | null;
  title: string;
  /** Package-relative launch path of the first SCO, including item parameters (query/fragment). */
  entryHref: string;
  scoIdentifier: string;
  scoTitle: string;
  scoCount: number;
  multiSco: boolean;
  items: ManifestItem[];
  /** Every SCO in organization order (the first one's settings are also at the top level). */
  scos: ScoInfo[];
  /** SCORM 1.2 adlcp:masteryscore (0–100). */
  masteryScore: number | null;
  /** SCORM 2004 imsss minNormalizedMeasure when satisfiedByMeasure (−1…1). */
  scaledPassingScore: number | null;
  /** SCORM 2004 adlcp:completionThreshold (0…1). */
  completionThreshold: number | null;
  launchData: string | null;
  maxTimeAllowed: string | null;
  timeLimitAction: string | null;
};

function detectVersion(manifest: XmlNode, schemaVersion: string | null): ScormVersion {
  const v = (schemaVersion ?? "").toLowerCase();
  if (v.includes("2004") || v.includes("cam 1.3") || v === "1.3") return "2004";
  if (v.includes("1.2")) return "1.2";
  const ns = Object.entries(manifest.attrs)
    .filter(([k]) => k.startsWith("xmlns"))
    .map(([, val]) => val.toLowerCase())
    .join(" ");
  if (ns.includes("adlcp_v1p3") || ns.includes("imsss") || ns.includes("adlseq")) return "2004";
  return "1.2";
}

/** Joins xml:base values and an href (manifest paths are URL-ish, relative to the package root). */
function joinHref(bases: (string | undefined)[], href: string) {
  let out = "";
  for (const b of bases) {
    if (!b) continue;
    out = /^[a-z]+:/i.test(b) || b.startsWith("/") ? b : out + b;
    if (out && !out.endsWith("/")) out += "/";
  }
  return /^[a-z]+:/i.test(href) ? href : out + href;
}

function appendParameters(href: string, parameters: string | undefined) {
  if (!parameters) return href;
  let p = parameters.trim();
  if (!p) return href;
  // SCORM CAM: strip a leading '?' or '&' when the href already has a query; '#' is appended as-is.
  if (p.startsWith("#")) return href.includes("#") ? href : href + p;
  if (p.startsWith("?") || p.startsWith("&")) p = p.slice(1);
  return href + (href.includes("?") ? "&" : "?") + p;
}

const num = (v: string | undefined) => {
  if (v === undefined || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function parseManifest(xml: string): ManifestInfo {
  const manifest = parseXml(xml);
  if (manifest.local !== "manifest") throw new ManifestError("imsmanifest.xml has no <manifest> root");
  const metadata = kid(manifest, "metadata");
  const schemaVersion = textOf(kid(metadata, "schemaversion")) || null;
  const version = detectVersion(manifest, schemaVersion);

  const resourcesEl = kid(manifest, "resources");
  const resources = new Map<string, { href: string | null; isSco: boolean }>();
  for (const r of kids(resourcesEl, "resource")) {
    const id = attr(r, "identifier");
    if (!id) continue;
    const type = (attr(r, "scormtype") ?? "").toLowerCase();
    const href = attr(r, "href");
    resources.set(id, {
      href: href ? joinHref([attr(manifest, "base"), attr(resourcesEl!, "base"), attr(r, "base")], href) : null,
      isSco: type === "sco",
    });
  }

  const orgsEl = kid(manifest, "organizations");
  const orgs = kids(orgsEl, "organization");
  const defaultId = orgsEl ? attr(orgsEl, "default") : undefined;
  const org = orgs.find((o) => attr(o, "identifier") === defaultId) ?? orgs[0];

  const items: ManifestItem[] = [];
  const meta = new Map<string, XmlNode>();
  const walk = (node: XmlNode) => {
    for (const item of kids(node, "item")) {
      if (items.length >= 1000) return;
      const identifier = attr(item, "identifier") ?? `item-${items.length + 1}`;
      const ref = attr(item, "identifierref") ?? null;
      const res = ref ? resources.get(ref) : undefined;
      items.push({
        identifier,
        title: textOf(kid(item, "title")).slice(0, 255) || identifier,
        resourceId: ref,
        href: res?.href ? appendParameters(res.href, attr(item, "parameters")) : null,
        isSco: !!res?.isSco,
      });
      meta.set(identifier, item);
      walk(item);
    }
  };
  if (org) walk(org);

  const launchable = items.filter((i) => i.href);
  const scos = launchable.filter((i) => i.isSco);
  let first = scos[0] ?? launchable[0];
  if (!first) {
    // No organization: fall back to the first SCO resource (or any resource with an href).
    const entries = [...resources.entries()];
    const [id, res] = entries.find(([, r]) => r.isSco && r.href) ?? entries.find(([, r]) => r.href) ?? [];
    if (!id || !res?.href) throw new ManifestError("The manifest has no launchable resource");
    first = { identifier: id, title: id, resourceId: id, href: res.href, isSco: res.isSco };
  }

  const scoInfo = (item: ManifestItem): ScoInfo => {
    const el = meta.get(item.identifier);
    let scaledPassingScore: number | null = null;
    const primary = kid(kid(kid(el, "sequencing"), "objectives"), "primaryObjective");
    if (primary && (attr(primary, "satisfiedByMeasure") ?? "").toLowerCase() === "true") {
      scaledPassingScore = num(textOf(kid(primary, "minNormalizedMeasure")) || "1");
    }
    const threshold = kid(el, "completionThreshold");
    return {
      identifier: item.identifier,
      title: item.title,
      href: item.href!,
      masteryScore: num(textOf(kid(el, "masteryscore"))),
      scaledPassingScore,
      completionThreshold: threshold ? num(attr(threshold, "minProgressMeasure") ?? textOf(threshold)) : null,
      launchData: textOf(kid(el, "datafromlms")).slice(0, 4096) || null,
      maxTimeAllowed: textOf(kid(el, "maxtimeallowed")) || null,
      timeLimitAction: textOf(kid(el, "timelimitaction")) || null,
    };
  };
  if (scos.length > MAX_SCOS) throw new ManifestError(`The package has ${scos.length} SCOs (max ${MAX_SCOS})`);
  const scoList = (scos.length ? scos : [first]).map(scoInfo);
  const head = scoList[0]!;

  return {
    version,
    schemaVersion,
    identifier: attr(manifest, "identifier") ?? null,
    title: textOf(kid(org, "title")).slice(0, 255) || first.title,
    entryHref: first.href!,
    scoIdentifier: first.identifier,
    scoTitle: first.title,
    scoCount: Math.max(1, scos.length),
    multiSco: scos.length > 1,
    items: items.slice(0, 100),
    scos: scoList,
    masteryScore: head.masteryScore,
    scaledPassingScore: head.scaledPassingScore,
    completionThreshold: head.completionThreshold,
    launchData: head.launchData,
    maxTimeAllowed: head.maxTimeAllowed,
    timeLimitAction: head.timeLimitAction,
  };
}

/** Splits a launch href into its package path (decoded) and the query/fragment suffix. */
export function splitHref(href: string): { path: string; suffix: string } {
  const cut = href.search(/[?#]/);
  const rawPath = cut < 0 ? href : href.slice(0, cut);
  let path = rawPath;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    /* keep raw */
  }
  return { path, suffix: cut < 0 ? "" : href.slice(cut) };
}
