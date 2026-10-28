/**
 * GIFT format (Moodle) parser and serializer, pure and unit-tested.
 *
 * Supported:
 *   ::title::  [html]/[moodle]/[plain]/[markdown] text format markers
 *   multichoice   {=right ~wrong}   multiple answers   {~%50%a ~%50%b ~%-100%c}
 *   per-answer feedback   ~wrong#Feedback
 *   true/false    {T} {F} {TRUE} {FALSE}
 *   short answer  {=a =%50%b}
 *   numerical     {#3.14:0.01}  {#1..5}  {#=%100%3.14:0.01 =%50%3.1:0.1}
 *   matching      {=a -> b =c -> d}   (distractor: "= -> e")
 *   essay         {}
 *   general feedback   {… ####Feedback}
 *   "missing word" text after the answer block (rendered as "_____")
 *   escapes \: \~ \= \# \{ \} \\ \n, and // comment lines
 *   $CATEGORY: lines (returned as a path for each following question)
 *
 * Not supported (reported as per-question errors): description questions
 * without an answer block, embedded answers (Cloze, several blocks).
 *
 * Question text and general feedback are HTML in this app. On export they are
 * written with the [html] marker; on import plain/markdown text is escaped and
 * line breaks become <br>.
 */

export type GiftQuestion = {
  type: "multichoice" | "truefalse" | "shortanswer" | "numerical" | "essay" | "matching";
  name: string;
  text: string;
  defaultMark: number;
  generalFeedback: string | null;
  data: Record<string, unknown>;
};

export type GiftParsed = {
  /** 1-based line where the question starts. */
  line: number;
  title: string | null;
  /** Category path from the last $CATEGORY line (null when none). */
  category: string[] | null;
  question: GiftQuestion;
  warnings: string[];
};

export type GiftError = { line: number; title: string | null; message: string };

export type GiftParseResult = { questions: GiftParsed[]; errors: GiftError[] };

// ─── Escaping ───────────────────────────────────────────────────────────────

const SPECIAL = new Set(["~", "=", "#", "{", "}", ":", "\\"]);

/** Escapes GIFT control characters and line breaks. */
export function giftEscape(s: string) {
  let out = "";
  for (const ch of s.replace(/\r\n?/g, "\n")) {
    if (ch === "\n") out += "\\n";
    else if (SPECIAL.has(ch)) out += `\\${ch}`;
    else out += ch;
  }
  return out;
}

/** Reverses giftEscape; unknown escapes (e.g. "\d") are kept verbatim. */
export function giftUnescape(s: string) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "\\" && i + 1 < s.length) {
      const next = s[i + 1]!;
      if (next === "n") {
        out += "\n";
        i++;
        continue;
      }
      if (SPECIAL.has(next)) {
        out += next;
        i++;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

/** Index of the first unescaped `needle` at or after `from`, or -1. */
function findUnescaped(s: string, needle: string, from = 0) {
  for (let i = from; i < s.length; i++) {
    if (s[i] === "\\") {
      i++;
      continue;
    }
    if (s.startsWith(needle, i)) return i;
  }
  return -1;
}

/** Splits at unescaped marker characters; each part starts with its marker. Text before the first marker is returned as `lead`. */
function splitItems(s: string, markers: string) {
  const items: string[] = [];
  let lead = "";
  let start = -1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\") {
      i++;
      continue;
    }
    if (markers.includes(s[i]!)) {
      if (start === -1) lead = s.slice(0, i);
      else items.push(s.slice(start, i));
      start = i;
    }
  }
  if (start === -1) lead = s;
  else items.push(s.slice(start));
  return { lead, items };
}

// ─── Text conversion ────────────────────────────────────────────────────────

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

type Format = "html" | "moodle" | "plain" | "markdown";

function toHtml(raw: string, format: Format) {
  const text = giftUnescape(raw).trim();
  if (format === "html") return text;
  if (format === "moodle") return text.replace(/\n/g, "<br>");
  return escapeHtml(text).replace(/\n/g, "<br>");
}

function plainName(html: string) {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .trim();
}

// ─── Parsing ────────────────────────────────────────────────────────────────

class GiftSyntaxError extends Error {}
const fail = (message: string): never => {
  throw new GiftSyntaxError(message);
};

const WEIGHT = /^%(-?\d+(?:\.\d+)?)%/;

type Item = { marker: "=" | "~"; weight: number | null; text: string; feedback: string | null };

function parseItem(raw: string): Item {
  const marker = raw[0] as "=" | "~";
  let rest = raw.slice(1).trim();
  let weight: number | null = null;
  const m = WEIGHT.exec(rest);
  if (m) {
    weight = Number(m[1]) / 100;
    if (weight < -1 || weight > 1) fail(`Answer weight ${m[1]}% is out of range (-100% to 100%)`);
    rest = rest.slice(m[0].length);
  }
  const hash = findUnescaped(rest, "#");
  const text = hash === -1 ? rest : rest.slice(0, hash);
  const feedback = hash === -1 ? null : rest.slice(hash + 1);
  return { marker, weight, text: giftUnescape(text).trim(), feedback: feedback === null ? null : giftUnescape(feedback).trim() };
}

function parseNumber(s: string) {
  const t = s.trim();
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) fail(`"${t}" is not a number`);
  return Number(t);
}

/** "3.14:0.01", "1..5" or "3" → value + tolerance. */
function parseNumericSpec(raw: string) {
  const s = giftUnescape(raw).trim();
  const range = s.indexOf("..");
  if (range !== -1) {
    const min = parseNumber(s.slice(0, range));
    const max = parseNumber(s.slice(range + 2));
    if (max < min) fail(`Invalid range ${s}`);
    return { value: (min + max) / 2, tolerance: (max - min) / 2 };
  }
  const colon = s.indexOf(":");
  if (colon !== -1) {
    const tolerance = Math.abs(parseNumber(s.slice(colon + 1)));
    return { value: parseNumber(s.slice(0, colon)), tolerance };
  }
  return { value: parseNumber(s), tolerance: 0 };
}

const optionId = (i: number) => (i < 26 ? String.fromCharCode(97 + i) : `o${i + 1}`);

function parseAnswers(body: string, warnings: string[]): { type: GiftQuestion["type"]; data: Record<string, unknown> } {
  const trimmed = body.trim();
  if (!trimmed) return { type: "essay", data: {} };

  // Numerical
  if (trimmed.startsWith("#")) {
    const content = trimmed.slice(1).trim();
    if (!content) fail("A numerical question needs an answer");
    const { lead, items } = splitItems(content, "=~");
    if (!items.length) {
      const hash = findUnescaped(content, "#");
      if (hash !== -1) warnings.push("Per-answer feedback is not supported for numerical questions and was dropped");
      return { type: "numerical", data: { answers: [{ ...parseNumericSpec(hash === -1 ? content : content.slice(0, hash)), fraction: 1 }] } };
    }
    if (lead.trim()) fail(`Unexpected text "${giftUnescape(lead).trim()}" in a numerical answer`);
    const answers = items.map((raw) => {
      const it = parseItem(raw);
      if (it.feedback) warnings.push("Per-answer feedback is not supported for numerical questions and was dropped");
      const fraction = it.weight ?? (it.marker === "=" ? 1 : 0);
      if (fraction < 0) fail("Numerical answers cannot have negative weights");
      return { ...parseNumericSpec(giftEscape(it.text)), fraction };
    });
    return { type: "numerical", data: { answers } };
  }

  // True / false
  const tf = /^(T|F|TRUE|FALSE)\s*(#[\s\S]*)?$/i.exec(trimmed);
  if (tf) {
    if (tf[2]) warnings.push("Feedback on true/false answers is not supported and was dropped");
    return { type: "truefalse", data: { correct: tf[1]!.toUpperCase().startsWith("T") } };
  }

  const { lead, items } = splitItems(trimmed, "=~");
  if (lead.trim()) fail(`Unrecognised answer format near "${giftUnescape(lead).trim().slice(0, 40)}"`);
  if (!items.length) fail("No answers found");

  const isPair = (raw: string) => findUnescaped(raw, "->") !== -1;
  const hasWrong = items.some((i) => i.startsWith("~"));

  if (hasWrong) {
    if (items.some(isPair)) fail("Matching pairs (->) cannot be mixed with ~ answers");
    const parsed = items.map(parseItem);
    const single = parsed.some((p) => p.marker === "=");
    return {
      type: "multichoice",
      data: {
        single,
        options: parsed.map((p, i) => ({
          id: optionId(i),
          text: p.text,
          fraction: p.weight ?? (p.marker === "=" ? 1 : 0),
          feedback: p.feedback ?? "",
        })),
      },
    };
  }

  const pairs = items.filter(isPair).length;
  if (pairs && pairs !== items.length) fail("Every answer of a matching question needs the form =question -> answer");
  if (pairs) {
    return {
      type: "matching",
      data: {
        pairs: items.map((raw, i) => {
          const s = raw.slice(1);
          const arrow = findUnescaped(s, "->");
          let left = s.slice(0, arrow);
          const w = WEIGHT.exec(left.trim());
          if (w) left = left.trim().slice(w[0].length);
          const right = s.slice(arrow + 2);
          if (findUnescaped(right, "#") !== -1) warnings.push("Feedback on matching pairs is not supported and was dropped");
          const hash = findUnescaped(right, "#");
          return {
            id: `p${i + 1}`,
            question: giftUnescape(left).trim(),
            answer: giftUnescape(hash === -1 ? right : right.slice(0, hash)).trim(),
          };
        }),
      },
    };
  }

  // Short answer
  const parsed = items.map(parseItem);
  if (parsed.some((p) => p.feedback)) warnings.push("Per-answer feedback is not supported for short-answer questions and was dropped");
  return {
    type: "shortanswer",
    data: {
      caseSensitive: false,
      answers: parsed.map((p) => {
        const fraction = p.weight ?? 1;
        if (fraction < 0) fail("Short answers cannot have negative weights");
        return { text: p.text, fraction };
      }),
    },
  };
}

function parseCategory(line: string) {
  const path = line.replace(/^\$CATEGORY:\s*/i, "").trim();
  // "//" is an escaped slash inside a name.
  const parts = path
    .replace(/\/\//g, "\u0000")
    .split("/")
    .map((p) => p.replace(/\u0000/g, "/").trim())
    .filter(Boolean);
  // Moodle prefixes: $course$, $system$, $module$, $cat1$… then "top".
  while (parts.length && /^\$[a-z0-9]+\$$/i.test(parts[0]!)) parts.shift();
  if (parts[0]?.toLowerCase() === "top") parts.shift();
  return parts;
}

function parseQuestion(block: string, warnings: string[]): { title: string | null; question: GiftQuestion } {
  let rest = block.trim();
  let title: string | null = null;
  if (rest.startsWith("::")) {
    const end = findUnescaped(rest, "::", 2);
    if (end === -1) fail("Unterminated ::title::");
    title = giftUnescape(rest.slice(2, end)).trim() || null;
    rest = rest.slice(end + 2).trim();
  }

  let format: Format = "moodle";
  const fm = /^\[(html|moodle|plain|markdown)\]/i.exec(rest);
  if (fm) {
    format = fm[1]!.toLowerCase() as Format;
    rest = rest.slice(fm[0].length);
  }

  const open = findUnescaped(rest, "{");
  if (open === -1) fail("No answer block {…} found (description questions are not supported)");
  const close = findUnescaped(rest, "}", open + 1);
  if (close === -1) fail("Unterminated answer block: missing }");
  const inner = rest.slice(open + 1, close);
  if (findUnescaped(inner, "{") !== -1) fail("Nested { inside an answer block; escape it as \\{");
  const after = rest.slice(close + 1);
  if (findUnescaped(after, "{") !== -1) fail("Several answer blocks (embedded answers / Cloze) are not supported");

  // General feedback: "####…" at the end of the answer block.
  const gfAt = findUnescaped(inner, "####");
  const answersRaw = gfAt === -1 ? inner : inner.slice(0, gfAt);
  const generalFeedback = gfAt === -1 ? null : toHtml(inner.slice(gfAt + 4), format) || null;

  const { type, data } = parseAnswers(answersRaw, warnings);

  const before = rest.slice(0, open).trim();
  const afterText = after.trim();
  const rawText = afterText ? `${before} _____ ${afterText}` : before;
  const text = toHtml(rawText, format);
  const name = (title ?? plainName(text)).slice(0, 255) || "Untitled question";
  return { title, question: { type, name, text, defaultMark: 1, generalFeedback, data } };
}

/** Parses a GIFT document. Never throws: problems are returned per question. */
export function parseGift(input: string): GiftParseResult {
  const lines = input.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  const questions: GiftParsed[] = [];
  const errors: GiftError[] = [];
  let category: string[] | null = null;

  let block: string[] = [];
  let blockLine = 0;
  const flush = () => {
    if (!block.length) return;
    const text = block.join("\n");
    const line = blockLine;
    block = [];
    const warnings: string[] = [];
    try {
      const { title, question } = parseQuestion(text, warnings);
      questions.push({ line, title, category, question, warnings: [...new Set(warnings)] });
    } catch (err) {
      if (!(err instanceof GiftSyntaxError)) throw err;
      const t = /^\s*::([\s\S]*?)::/.exec(text);
      errors.push({ line, title: t ? giftUnescape(t[1]!).trim() : null, message: err.message });
    }
  };

  lines.forEach((raw, i) => {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (trimmed.startsWith("//")) return;
    if (!trimmed) {
      flush();
      return;
    }
    if (/^\$CATEGORY:/i.test(trimmed)) {
      flush();
      category = parseCategory(trimmed);
      if (!category.length) category = null;
      return;
    }
    if (!block.length) blockLine = i + 1;
    block.push(line);
  });
  flush();
  return { questions, errors };
}

// ─── Serializing ────────────────────────────────────────────────────────────

const pct = (f: number) => String(Math.round(f * 100 * 100_000) / 100_000);
const num = (n: number) => String(n);
const isOne = (f: number) => Math.abs(f - 1) < 1e-9;

type AnyData = Record<string, unknown>;

function answerLines(q: GiftQuestion): string[] {
  const d = q.data as AnyData;
  switch (q.type) {
    case "multichoice": {
      const opts = (d.options as { text: string; fraction: number; feedback?: string }[]) ?? [];
      const single = d.single !== false;
      return opts.map((o) => {
        let marker: string;
        if (single && isOne(o.fraction)) marker = "=";
        else if (o.fraction === 0) marker = "~";
        else marker = `~%${pct(o.fraction)}%`;
        return `${marker}${giftEscape(o.text)}${o.feedback ? `#${giftEscape(o.feedback)}` : ""}`;
      });
    }
    case "shortanswer":
      return ((d.answers as { text: string; fraction: number }[]) ?? []).map((a) => `=${isOne(a.fraction) ? "" : `%${pct(a.fraction)}%`}${giftEscape(a.text)}`);
    case "numerical": {
      const answers = (d.answers as { value: number; tolerance?: number; fraction: number }[]) ?? [];
      const spec = (a: { value: number; tolerance?: number }) => (a.tolerance ? `${num(a.value)}:${num(a.tolerance)}` : num(a.value));
      return answers.map((a) => `=%${pct(a.fraction)}%${spec(a)}`);
    }
    case "matching":
      return ((d.pairs as { question: string; answer: string }[]) ?? []).map((p) => `=${giftEscape(p.question)} -> ${giftEscape(p.answer)}`);
    default:
      return [];
  }
}

function serializeOne(q: GiftQuestion) {
  const head = `::${giftEscape(q.name)}::[html]${giftEscape(q.text)}`;
  const gf = q.generalFeedback ? `####${giftEscape(q.generalFeedback)}` : "";
  const d = q.data as AnyData;

  if (q.type === "truefalse") return `${head}{${d.correct ? "TRUE" : "FALSE"}${gf}}`;
  if (q.type === "essay") return `${head}{${gf}}`;
  if (q.type === "numerical") {
    const answers = (d.answers as { value: number; tolerance?: number; fraction: number }[]) ?? [];
    if (answers.length === 1 && isOne(answers[0]!.fraction)) {
      const a = answers[0]!;
      return `${head}{#${a.tolerance ? `${num(a.value)}:${num(a.tolerance)}` : num(a.value)}${gf}}`;
    }
    return `${head}{#\n${answerLines(q)
      .map((l) => `\t${l}`)
      .join("\n")}${gf ? `\n\t${gf}` : ""}\n}`;
  }
  const lines = answerLines(q).map((l) => `\t${l}`);
  if (gf) lines.push(`\t${gf}`);
  return `${head}{\n${lines.join("\n")}\n}`;
}

/** Serializes questions as a GIFT document. Default marks, essay templates and case sensitivity have no GIFT syntax and are not written. */
export function serializeGift(questions: GiftQuestion[], opts: { comment?: string } = {}) {
  const parts: string[] = [];
  if (opts.comment) parts.push(opts.comment.split(/\r?\n/).map((l) => `// ${l}`).join("\n"));
  for (const q of questions) parts.push(serializeOne(q));
  return `${parts.join("\n\n")}\n`;
}
