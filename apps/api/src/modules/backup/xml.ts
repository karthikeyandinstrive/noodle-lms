/**
 * Small, safe XML parser for Moodle backup files.
 *
 * Supports elements, attributes, text, CDATA, comments and processing
 * instructions. DOCTYPE declarations are rejected (no external entities, no
 * entity expansion attacks); only the five predefined entities and numeric
 * character references are decoded. Depth and node counts are bounded.
 */

export type XmlNode = { name: string; attrs: Record<string, string>; children: XmlNode[]; text: string };

export class XmlError extends Error {}

const MAX_DEPTH = 200;
const MAX_NODES = 2_000_000;

function decode(s: string) {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_m, e: string) => {
    const k = e.toLowerCase();
    if (k === "amp") return "&";
    if (k === "lt") return "<";
    if (k === "gt") return ">";
    if (k === "quot") return '"';
    if (k === "apos") return "'";
    const code = k.startsWith("#x") ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
    try {
      return String.fromCodePoint(code);
    } catch {
      return "";
    }
  });
}

export function parseXml(input: string): XmlNode {
  const src = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const root: XmlNode = { name: "#document", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  let i = 0;
  let nodes = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf("<", i);
    const top = stack[stack.length - 1]!;
    if (lt < 0) {
      top.text += decode(src.slice(i));
      break;
    }
    if (lt > i) top.text += decode(src.slice(i, lt));
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      if (end < 0) throw new XmlError("Unterminated comment");
      i = end + 3;
    } else if (src.startsWith("<![CDATA[", lt)) {
      const end = src.indexOf("]]>", lt + 9);
      if (end < 0) throw new XmlError("Unterminated CDATA");
      top.text += src.slice(lt + 9, end);
      i = end + 3;
    } else if (src.startsWith("<?", lt)) {
      const end = src.indexOf("?>", lt + 2);
      if (end < 0) throw new XmlError("Unterminated processing instruction");
      i = end + 2;
    } else if (src.startsWith("<!", lt)) {
      throw new XmlError("DOCTYPE and entity declarations are not allowed");
    } else if (src[lt + 1] === "/") {
      const end = src.indexOf(">", lt);
      if (end < 0) throw new XmlError("Unterminated closing tag");
      const name = src.slice(lt + 2, end).trim();
      if (stack.length <= 1 || top.name !== name) throw new XmlError(`Unexpected closing tag </${name}>`);
      stack.pop();
      i = end + 1;
    } else {
      // Opening tag: find its end, honouring quoted attribute values.
      let j = lt + 1;
      let quote: string | null = null;
      while (j < n) {
        const c = src[j]!;
        if (quote) {
          if (c === quote) quote = null;
        } else if (c === '"' || c === "'") quote = c;
        else if (c === ">") break;
        j++;
      }
      if (j >= n) throw new XmlError("Unterminated tag");
      let body = src.slice(lt + 1, j);
      const selfClosing = body.endsWith("/");
      if (selfClosing) body = body.slice(0, -1);
      const m = /^([^\s/>]+)/.exec(body);
      if (!m) throw new XmlError("Invalid tag");
      const node: XmlNode = { name: m[1]!, attrs: {}, children: [], text: "" };
      const attrRe = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
      let a: RegExpExecArray | null;
      const rest = body.slice(m[0].length);
      while ((a = attrRe.exec(rest))) node.attrs[a[1]!] = decode(a[3] ?? a[4] ?? "");
      if (++nodes > MAX_NODES) throw new XmlError("XML document is too large");
      top.children.push(node);
      if (!selfClosing) {
        if (stack.length > MAX_DEPTH) throw new XmlError("XML nesting is too deep");
        stack.push(node);
      }
      i = j + 1;
    }
  }
  if (stack.length !== 1) throw new XmlError(`Unclosed element <${stack[stack.length - 1]!.name}>`);
  return root;
}

/** First child element with this name. */
export function child(node: XmlNode | null | undefined, name: string): XmlNode | null {
  return node?.children.find((c) => c.name === name) ?? null;
}

export function children(node: XmlNode | null | undefined, name: string): XmlNode[] {
  return node?.children.filter((c) => c.name === name) ?? [];
}

/** Follows a path of child names, e.g. path(doc, "moodle_backup", "information"). */
export function path(node: XmlNode | null | undefined, ...names: string[]): XmlNode | null {
  let cur: XmlNode | null | undefined = node;
  for (const n of names) cur = child(cur, n);
  return cur ?? null;
}

/** Text of a child element; Moodle writes "$@NULL@$" for nulls. */
export function textOf(node: XmlNode | null | undefined, name: string): string | null {
  const c = child(node, name);
  if (!c) return null;
  const t = c.text.trim();
  return t === "$@NULL@$" ? null : c.text;
}

export function numberOf(node: XmlNode | null | undefined, name: string): number | null {
  const t = textOf(node, name);
  if (t === null || t.trim() === "") return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}
