import { z } from "zod";
import { checkFormula, evaluate, FormulaError, roundTo, variablesIn } from "./formula";

/**
 * Question types: the `data` shape stored in question_versions.data, the
 * learner response shape, the learner-safe view, and pure grading.
 *
 * Shared by the question bank (authoring/validation) and the quiz engine
 * (attempts/grading). Everything here is pure — no DB access — so it is unit-tested.
 */

export const QUESTION_TYPES = ["multichoice", "truefalse", "shortanswer", "numerical", "essay", "matching", "calculated", "gapselect"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

const zFraction = z.number().min(-1).max(1);
const zShortId = z.string().trim().min(1).max(64);
const zPlain = (max: number) => z.string().max(max);

// ─── Data (authoring) schemas ───────────────────────────────────────────────

export const zMultichoiceData = z
  .object({
    single: z.boolean(),
    options: z
      .array(z.object({ id: zShortId, text: zPlain(2000).min(1), fraction: zFraction, feedback: zPlain(2000).default("") }))
      .min(2)
      .max(26),
  })
  .superRefine((d, ctx) => {
    const ids = new Set(d.options.map((o) => o.id));
    if (ids.size !== d.options.length) ctx.addIssue({ code: "custom", message: "Option ids must be unique", path: ["options"] });
    if (d.single) {
      if (!d.options.some((o) => Math.abs(o.fraction - 1) < 1e-6)) {
        ctx.addIssue({ code: "custom", message: "One option must be worth 100%", path: ["options"] });
      }
    } else {
      const positive = d.options.filter((o) => o.fraction > 0).reduce((s, o) => s + o.fraction, 0);
      if (Math.abs(positive - 1) > 0.001) {
        ctx.addIssue({ code: "custom", message: "Positive option fractions must add up to 100%", path: ["options"] });
      }
    }
  });

export const zTruefalseData = z.object({ correct: z.boolean() });

export const zShortanswerData = z
  .object({
    caseSensitive: z.boolean().default(false),
    answers: z
      .array(z.object({ text: zPlain(500).trim().min(1), fraction: z.number().min(0).max(1) }))
      .min(1)
      .max(50),
  })
  .refine((d) => d.answers.some((a) => Math.abs(a.fraction - 1) < 1e-6), { message: "One answer must be worth 100%", path: ["answers"] });

export const zNumericalData = z
  .object({
    answers: z
      .array(z.object({ value: z.number().finite(), tolerance: z.number().min(0).finite().default(0), fraction: z.number().min(0).max(1) }))
      .min(1)
      .max(50),
  })
  .refine((d) => d.answers.some((a) => Math.abs(a.fraction - 1) < 1e-6), { message: "One answer must be worth 100%", path: ["answers"] });

export const zEssayData = z.object({
  responseTemplate: zPlain(10_000).optional(),
  minWords: z.number().int().min(0).max(100_000).optional(),
});

export const zMatchingData = z
  .object({
    /** Pairs with an empty `question` are distractors (extra answers). */
    pairs: z
      .array(z.object({ id: zShortId, question: zPlain(1000).default(""), answer: zPlain(500).trim().min(1) }))
      .min(2)
      .max(30),
  })
  .superRefine((d, ctx) => {
    if (new Set(d.pairs.map((p) => p.id)).size !== d.pairs.length) ctx.addIssue({ code: "custom", message: "Pair ids must be unique", path: ["pairs"] });
    if (d.pairs.filter((p) => p.question.trim()).length < 2) ctx.addIssue({ code: "custom", message: "At least two pairs need a question", path: ["pairs"] });
  });

const zVarName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, "Variable names use letters, digits and _");

/**
 * Calculated: the question text uses {name} wildcards (and {=formula} for computed values);
 * each attempt draws values (or one of the fixed `datasets`) and answers are formulas over them.
 */
export const zCalculatedData = z
  .object({
    answers: z
      .array(
        z.object({
          formula: z.string().trim().min(1).max(1000),
          fraction: z.number().min(0).max(1),
          tolerance: z.number().min(0).finite().default(0.01),
          /** relative: ± tolerance × |answer|; nominal: ± tolerance; geometric: answer ÷ (1+t) … answer × (1+t). */
          toleranceType: z.enum(["relative", "nominal", "geometric"]).default("relative"),
          /** How the correct answer is shown in review. */
          answerDecimals: z.number().int().min(0).max(10).default(2),
          answerFormat: z.enum(["decimals", "significant"]).default("decimals"),
        }),
      )
      .min(1)
      .max(20),
    variables: z
      .array(z.object({ name: zVarName, min: z.number().finite(), max: z.number().finite(), decimals: z.number().int().min(0).max(10).default(1) }))
      .min(1)
      .max(20),
    /** Fixed value sets (Moodle datasets): when present, each attempt uses one of them instead of random values. */
    datasets: z.array(z.record(zVarName, z.number().finite())).max(200).default([]),
  })
  .superRefine((d, ctx) => {
    const names = d.variables.map((v) => v.name);
    if (new Set(names).size !== names.length) ctx.addIssue({ code: "custom", message: "Variable names must be unique", path: ["variables"] });
    d.variables.forEach((v, i) => {
      if (v.max < v.min) ctx.addIssue({ code: "custom", message: `{${v.name}}: maximum is below minimum`, path: ["variables", i, "max"] });
    });
    d.answers.forEach((a, i) => {
      const error = checkFormula(a.formula, names);
      if (error) ctx.addIssue({ code: "custom", message: `Answer ${i + 1}: ${error}`, path: ["answers", i, "formula"] });
    });
    if (!d.answers.some((a) => Math.abs(a.fraction - 1) < 1e-6)) ctx.addIssue({ code: "custom", message: "One answer must be worth 100%", path: ["answers"] });
    d.datasets.forEach((set, i) => {
      const missing = names.filter((n) => !(n in set));
      if (missing.length) ctx.addIssue({ code: "custom", message: `Dataset ${i + 1} has no value for {${missing[0]}}`, path: ["datasets", i] });
    });
  });

/**
 * Gap select (Moodle "select missing words" and "drag and drop into text"): the question text has
 * [[n]] gaps, each answered by choice n; a gap offers the choices of the same group.
 */
export const zGapselectData = z.object({
  choices: z
    .array(z.object({ text: zPlain(500).trim().min(1), group: z.number().int().min(1).max(20).default(1) }))
    .min(2)
    .max(100),
  shuffle: z.boolean().default(true),
});

/** The [[n]] gaps of a gap-select question text, in order (choice numbers, 1-based). */
export function gapsIn(text: string) {
  return [...text.matchAll(/\[\[(\d{1,3})\]\]/g)].map((m) => Number(m[1]));
}

export const DATA_SCHEMAS = {
  multichoice: zMultichoiceData,
  truefalse: zTruefalseData,
  shortanswer: zShortanswerData,
  numerical: zNumericalData,
  essay: zEssayData,
  matching: zMatchingData,
  calculated: zCalculatedData,
  gapselect: zGapselectData,
} as const;

export type QuestionData = {
  multichoice: z.infer<typeof zMultichoiceData>;
  truefalse: z.infer<typeof zTruefalseData>;
  shortanswer: z.infer<typeof zShortanswerData>;
  numerical: z.infer<typeof zNumericalData>;
  essay: z.infer<typeof zEssayData>;
  matching: z.infer<typeof zMatchingData>;
  calculated: z.infer<typeof zCalculatedData>;
  gapselect: z.infer<typeof zGapselectData>;
};

/** Common authoring fields + type-specific data (discriminated by `type`). */
const common = {
  name: z.string().trim().min(1).max(255),
  text: z.string().min(1).max(50_000),
  defaultMark: z.number().min(0).max(1000).default(1),
  generalFeedback: z.string().max(20_000).nullable().optional(),
};
export const zQuestionInput = z
  .discriminatedUnion("type", [
  z.object({ type: z.literal("multichoice"), data: zMultichoiceData, ...common }),
  z.object({ type: z.literal("truefalse"), data: zTruefalseData, ...common }),
  z.object({ type: z.literal("shortanswer"), data: zShortanswerData, ...common }),
  z.object({ type: z.literal("numerical"), data: zNumericalData, ...common }),
  z.object({ type: z.literal("essay"), data: zEssayData, ...common }),
  z.object({ type: z.literal("matching"), data: zMatchingData, ...common }),
  z.object({ type: z.literal("calculated"), data: zCalculatedData, ...common }),
  z.object({ type: z.literal("gapselect"), data: zGapselectData, ...common }),
  ])
  .superRefine((q, ctx) => {
    if (q.type !== "gapselect") return;
    const gaps = gapsIn(q.text);
    if (!gaps.length) ctx.addIssue({ code: "custom", message: "Add at least one gap like [[1]] to the question text", path: ["text"] });
    const bad = gaps.find((n) => n < 1 || n > q.data.choices.length);
    if (bad !== undefined) ctx.addIssue({ code: "custom", message: `Gap [[${bad}]] has no choice ${bad}`, path: ["text"] });
  });
export type QuestionInput = z.infer<typeof zQuestionInput>;

// ─── Responses ──────────────────────────────────────────────────────────────

export const zMultichoiceResponse = z.object({ selected: z.array(zShortId).max(26) });
export const zTruefalseResponse = z.object({ value: z.boolean() });
export const zTextResponse = z.object({ text: z.string().max(100_000) });
export const zNumericalResponse = z.object({ value: z.string().max(100) });
/** questionPairId → chosen answer text (answers are offered as distinct texts, so ids never leak the mapping). */
export const zMatchingResponse = z.object({ matches: z.record(zShortId, z.string().max(500)) });

/** Gap number (1-based, in text order) → chosen choice text. */
export const zGapselectResponse = z.object({ gaps: z.record(z.string().regex(/^\d{1,3}$/), z.string().max(500)) });

export const RESPONSE_SCHEMAS = {
  multichoice: zMultichoiceResponse,
  truefalse: zTruefalseResponse,
  shortanswer: zTextResponse,
  numerical: zNumericalResponse,
  essay: zTextResponse,
  matching: zMatchingResponse,
  calculated: zNumericalResponse,
  gapselect: zGapselectResponse,
} as const;

/** Validates a learner response for a type; returns null for invalid shapes. */
export function parseResponse(type: QuestionType, response: unknown): unknown | null {
  if (response === null || response === undefined) return null;
  const r = RESPONSE_SCHEMAS[type].safeParse(response);
  return r.success ? r.data : null;
}

// ─── Grading ────────────────────────────────────────────────────────────────

export type GradeResult = { fraction: number | null };

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

function wildcardToRegExp(pattern: string, caseSensitive: boolean) {
  const escaped = pattern
    .trim()
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`, caseSensitive ? "" : "i");
}

/** Parses a learner's numeric input ("3.5", "3,5", " 1e3 "); NaN when not a number. */
export function parseNumber(input: string) {
  const s = input.trim().replace(/\s+/g, "").replace(",", ".");
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return NaN;
  return Number(s);
}

export function countWords(text: string) {
  const plain = text.replace(/<[^>]*>/g, " ").trim();
  return plain ? plain.split(/\s+/).length : 0;
}

/** The attempt's context for a question: its frozen variant and the question text (gap select reads its gaps from it). */
export type QuestionContext = { variant?: Variant; text?: string };

/** Values of a calculated question's wildcards for an attempt (midpoints when no variant was frozen). */
export function calculatedValues(d: QuestionData["calculated"], variant?: Variant): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of d.variables) out[v.name] = variant?.values?.[v.name] ?? roundTo((v.min + v.max) / 2, v.decimals);
  return out;
}

function withinTolerance(value: number, answer: number, tolerance: number, type: "relative" | "nominal" | "geometric") {
  const eps = 1e-9 * Math.max(1, Math.abs(answer));
  if (type === "nominal") return Math.abs(value - answer) <= tolerance + eps;
  if (type === "relative") return Math.abs(value - answer) <= tolerance * Math.abs(answer) + eps;
  if (answer === 0) return Math.abs(value) <= tolerance + eps;
  const ratio = value / answer;
  return ratio > 0 && ratio >= 1 / (1 + tolerance) - eps && ratio <= 1 + tolerance + eps;
}

function safeEvaluate(formula: string, values: Record<string, number>) {
  try {
    const v = evaluate(formula, values);
    return Number.isFinite(v) ? v : null;
  } catch (err) {
    if (err instanceof FormulaError) return null;
    throw err;
  }
}

/** Correct answer of a calculated answer, formatted the way the author asked. */
function formatCalculated(value: number, a: QuestionData["calculated"]["answers"][number]) {
  if (a.answerFormat === "significant") return Number(value.toPrecision(Math.max(1, a.answerDecimals))).toString();
  return roundTo(value, a.answerDecimals).toFixed(a.answerDecimals);
}

/**
 * Grades one response. `fraction` is 0..1; `null` means it needs manual grading.
 * A missing/invalid response scores 0 (an empty essay is not sent for manual grading).
 */
export function gradeResponse(type: QuestionType, data: unknown, response: unknown, ctx: QuestionContext = {}): GradeResult {
  const parsedData = DATA_SCHEMAS[type].safeParse(data);
  if (!parsedData.success) return { fraction: 0 };
  const r = parseResponse(type, response);

  switch (type) {
    case "multichoice": {
      const d = parsedData.data as QuestionData["multichoice"];
      const sel = (r as z.infer<typeof zMultichoiceResponse> | null)?.selected ?? [];
      const unique = [...new Set(sel)];
      if (!unique.length) return { fraction: 0 };
      if (d.single && unique.length > 1) return { fraction: 0 };
      const byId = new Map(d.options.map((o) => [o.id, o.fraction]));
      const sum = unique.reduce((s, id) => s + (byId.get(id) ?? 0), 0);
      return { fraction: clamp01(sum) };
    }
    case "truefalse": {
      const d = parsedData.data as QuestionData["truefalse"];
      const v = (r as z.infer<typeof zTruefalseResponse> | null)?.value;
      if (v === undefined) return { fraction: 0 };
      return { fraction: v === d.correct ? 1 : 0 };
    }
    case "shortanswer": {
      const d = parsedData.data as QuestionData["shortanswer"];
      const text = ((r as z.infer<typeof zTextResponse> | null)?.text ?? "").trim().replace(/\s+/g, " ");
      if (!text) return { fraction: 0 };
      let best = 0;
      for (const a of d.answers) {
        if (wildcardToRegExp(a.text, d.caseSensitive).test(text)) best = Math.max(best, a.fraction);
      }
      return { fraction: best };
    }
    case "numerical": {
      const d = parsedData.data as QuestionData["numerical"];
      const raw = (r as z.infer<typeof zNumericalResponse> | null)?.value;
      if (raw === undefined) return { fraction: 0 };
      const v = parseNumber(raw);
      if (Number.isNaN(v)) return { fraction: 0 };
      let best = 0;
      for (const a of d.answers) {
        // Small epsilon absorbs floating point noise (0.1 + 0.2).
        if (Math.abs(v - a.value) <= a.tolerance + 1e-9 * Math.max(1, Math.abs(a.value))) best = Math.max(best, a.fraction);
      }
      return { fraction: best };
    }
    case "essay": {
      const text = (r as z.infer<typeof zTextResponse> | null)?.text ?? "";
      if (!countWords(text)) return { fraction: 0 };
      return { fraction: null };
    }
    case "matching": {
      const d = parsedData.data as QuestionData["matching"];
      const matches = (r as z.infer<typeof zMatchingResponse> | null)?.matches ?? {};
      const stems = d.pairs.filter((p) => p.question.trim());
      if (!stems.length) return { fraction: 0 };
      const correct = stems.filter((p) => (matches[p.id] ?? "").trim() === p.answer.trim()).length;
      return { fraction: correct / stems.length };
    }
    case "calculated": {
      const d = parsedData.data as QuestionData["calculated"];
      const raw = (r as z.infer<typeof zNumericalResponse> | null)?.value;
      if (raw === undefined) return { fraction: 0 };
      const v = parseNumber(raw);
      if (Number.isNaN(v)) return { fraction: 0 };
      const values = calculatedValues(d, ctx.variant);
      let best = 0;
      for (const a of d.answers) {
        const expected = safeEvaluate(a.formula, values);
        if (expected !== null && withinTolerance(v, expected, a.tolerance, a.toleranceType)) best = Math.max(best, a.fraction);
      }
      return { fraction: best };
    }
    case "gapselect": {
      const d = parsedData.data as QuestionData["gapselect"];
      const gaps = gapsIn(ctx.text ?? "");
      if (!gaps.length) return { fraction: 0 };
      const chosen = (r as { gaps: Record<string, string> } | null)?.gaps ?? {};
      const correct = gaps.filter((n, i) => {
        const want = d.choices[n - 1]?.text.trim();
        return want !== undefined && (chosen[String(i + 1)] ?? "").trim() === want;
      }).length;
      return { fraction: correct / gaps.length };
    }
  }
}

// ─── Attempt variants (shuffling) and learner-safe views ────────────────────

export type Variant = { order?: string[]; stems?: string[]; choices?: string[]; values?: Record<string, number> };

export function shuffle<T>(items: T[], rng: () => number = Math.random) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Freezes the presentation order for one attempt (stored in attempt_answers.variant). */
export function makeVariant(type: QuestionType, data: unknown, shuffleAnswers: boolean, rng: () => number = Math.random): Variant {
  if (type === "multichoice") {
    const d = data as QuestionData["multichoice"];
    const ids = d.options.map((o) => o.id);
    return { order: shuffleAnswers ? shuffle(ids, rng) : ids };
  }
  if (type === "matching") {
    const d = data as QuestionData["matching"];
    const stems = d.pairs.filter((p) => p.question.trim()).map((p) => p.id);
    const choices = [...new Set(d.pairs.map((p) => p.answer.trim()))];
    // Choices are always shuffled, otherwise their order would reveal the pairing.
    return { stems: shuffleAnswers ? shuffle(stems, rng) : stems, choices: shuffle(choices, rng) };
  }
  if (type === "calculated") {
    const d = data as QuestionData["calculated"];
    if (d.datasets?.length) {
      const set = d.datasets[Math.floor(rng() * d.datasets.length)]!;
      return { values: Object.fromEntries(d.variables.map((v) => [v.name, set[v.name] ?? v.min])) };
    }
    return { values: Object.fromEntries(d.variables.map((v) => [v.name, roundTo(v.min + rng() * (v.max - v.min), v.decimals)])) };
  }
  if (type === "gapselect") {
    const d = data as QuestionData["gapselect"];
    const ids = d.choices.map((_, i) => String(i + 1));
    return { order: d.shuffle === false ? ids : shuffle(ids, rng) };
  }
  return {};
}

/**
 * The question text as the learner sees it in this attempt: calculated wildcards ({x}, {=formula})
 * filled in, gap-select [[n]] gaps numbered. Inserted values are numbers and fixed markup only.
 */
export function presentText(type: QuestionType, data: unknown, text: string, variant: Variant): string {
  if (type === "calculated") {
    const parsed = zCalculatedData.safeParse(data);
    if (!parsed.success) return text;
    const values = calculatedValues(parsed.data, variant);
    return text
      .replace(/\{=((?:[^{}]|\{[A-Za-z_][A-Za-z0-9_]{0,63}\})+)\}/g, (m, expr: string) => {
        const v = safeEvaluate(expr, values);
        return v === null ? m : String(roundTo(v, 10));
      })
      .replace(/\{([A-Za-z_][A-Za-z0-9_]{0,63})\}/g, (m, name: string) => (name in values ? String(values[name]) : m));
  }
  if (type === "gapselect") {
    let k = 0;
    return text.replace(/\[\[(\d{1,3})\]\]/g, () => `<strong>[${++k}]</strong>`);
  }
  return text;
}

/** What a learner may see of a question while attempting it — never fractions, answers or feedback. */
export type StudentView =
  | { type: "multichoice"; single: boolean; options: { id: string; text: string }[] }
  | { type: "truefalse" }
  | { type: "shortanswer" }
  | { type: "numerical" }
  | { type: "essay"; responseTemplate: string | null; minWords: number | null }
  | { type: "matching"; stems: { id: string; text: string }[]; choices: string[] }
  | { type: "calculated" }
  | { type: "gapselect"; gaps: { id: string; options: string[] }[] };

export function studentView(type: QuestionType, data: unknown, variant: Variant, text = ""): StudentView {
  switch (type) {
    case "multichoice": {
      const d = data as QuestionData["multichoice"];
      const byId = new Map(d.options.map((o) => [o.id, o]));
      const order = variant.order?.filter((id) => byId.has(id)) ?? d.options.map((o) => o.id);
      return { type, single: d.single, options: order.map((id) => ({ id, text: byId.get(id)!.text })) };
    }
    case "essay": {
      const d = data as QuestionData["essay"];
      return { type, responseTemplate: d.responseTemplate ?? null, minWords: d.minWords ?? null };
    }
    case "matching": {
      const d = data as QuestionData["matching"];
      const byId = new Map(d.pairs.map((p) => [p.id, p]));
      const stems = (variant.stems ?? d.pairs.filter((p) => p.question.trim()).map((p) => p.id)).filter((id) => byId.has(id));
      return {
        type,
        stems: stems.map((id) => ({ id, text: byId.get(id)!.question })),
        choices: variant.choices ?? [...new Set(d.pairs.map((p) => p.answer.trim()))].sort(),
      };
    }
    case "gapselect": {
      const d = data as QuestionData["gapselect"];
      const order = (variant.order ?? d.choices.map((_, i) => String(i + 1))).map(Number).filter((n) => d.choices[n - 1]);
      return {
        type,
        gaps: gapsIn(text).map((n, i) => {
          const group = d.choices[n - 1]?.group ?? 1;
          return { id: String(i + 1), options: [...new Set(order.filter((c) => (d.choices[c - 1]!.group ?? 1) === group).map((c) => d.choices[c - 1]!.text.trim()))] };
        }),
      };
    }
    default:
      return { type } as StudentView;
  }
}

/** Human-readable correct answer, shown in review when `rightAnswer` is enabled. */
export function rightAnswerText(type: QuestionType, data: unknown, ctx: QuestionContext = {}): string | null {
  switch (type) {
    case "multichoice": {
      const d = data as QuestionData["multichoice"];
      return d.options
        .filter((o) => o.fraction > 0)
        .map((o) => o.text)
        .join("; ");
    }
    case "truefalse":
      return (data as QuestionData["truefalse"]).correct ? "True" : "False";
    case "shortanswer": {
      const best = (data as QuestionData["shortanswer"]).answers.find((a) => a.fraction >= 1);
      return best?.text ?? null;
    }
    case "numerical": {
      const best = (data as QuestionData["numerical"]).answers.find((a) => a.fraction >= 1);
      return best ? (best.tolerance ? `${best.value} ± ${best.tolerance}` : String(best.value)) : null;
    }
    case "matching":
      return (data as QuestionData["matching"]).pairs
        .filter((p) => p.question.trim())
        .map((p) => `${p.question} → ${p.answer}`)
        .join("; ");
    case "essay":
      return null;
    case "calculated": {
      const d = data as QuestionData["calculated"];
      const best = d.answers.find((a) => a.fraction >= 1);
      const value = best ? safeEvaluate(best.formula, calculatedValues(d, ctx.variant)) : null;
      return best && value !== null ? formatCalculated(value, best) : null;
    }
    case "gapselect": {
      const d = data as QuestionData["gapselect"];
      return gapsIn(ctx.text ?? "")
        .map((n, i) => `[${i + 1}] ${d.choices[n - 1]?.text ?? "?"}`)
        .join("; ");
    }
  }
}

/** Per-response feedback the author attached (multichoice option feedback). */
export function responseFeedback(type: QuestionType, data: unknown, response: unknown): string | null {
  if (type !== "multichoice") return null;
  const d = data as QuestionData["multichoice"];
  const r = parseResponse(type, response) as z.infer<typeof zMultichoiceResponse> | null;
  if (!r?.selected.length) return null;
  const text = d.options
    .filter((o) => r.selected.includes(o.id) && o.feedback)
    .map((o) => o.feedback)
    .join("\n");
  return text || null;
}

export function correctnessOf(fraction: number | null): "correct" | "partial" | "incorrect" | "needs_grading" {
  if (fraction === null) return "needs_grading";
  if (fraction >= 0.9999999) return "correct";
  if (fraction > 0) return "partial";
  return "incorrect";
}
