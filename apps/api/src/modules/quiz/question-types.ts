import { z } from "zod";

/**
 * Question types: the `data` shape stored in question_versions.data, the
 * learner response shape, the learner-safe view, and pure grading.
 *
 * Shared by the question bank (authoring/validation) and the quiz engine
 * (attempts/grading). Everything here is pure — no DB access — so it is unit-tested.
 */

export const QUESTION_TYPES = ["multichoice", "truefalse", "shortanswer", "numerical", "essay", "matching"] as const;
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

export const DATA_SCHEMAS = {
  multichoice: zMultichoiceData,
  truefalse: zTruefalseData,
  shortanswer: zShortanswerData,
  numerical: zNumericalData,
  essay: zEssayData,
  matching: zMatchingData,
} as const;

export type QuestionData = {
  multichoice: z.infer<typeof zMultichoiceData>;
  truefalse: z.infer<typeof zTruefalseData>;
  shortanswer: z.infer<typeof zShortanswerData>;
  numerical: z.infer<typeof zNumericalData>;
  essay: z.infer<typeof zEssayData>;
  matching: z.infer<typeof zMatchingData>;
};

/** Common authoring fields + type-specific data (discriminated by `type`). */
const common = {
  name: z.string().trim().min(1).max(255),
  text: z.string().min(1).max(50_000),
  defaultMark: z.number().min(0).max(1000).default(1),
  generalFeedback: z.string().max(20_000).nullable().optional(),
};
export const zQuestionInput = z.discriminatedUnion("type", [
  z.object({ type: z.literal("multichoice"), data: zMultichoiceData, ...common }),
  z.object({ type: z.literal("truefalse"), data: zTruefalseData, ...common }),
  z.object({ type: z.literal("shortanswer"), data: zShortanswerData, ...common }),
  z.object({ type: z.literal("numerical"), data: zNumericalData, ...common }),
  z.object({ type: z.literal("essay"), data: zEssayData, ...common }),
  z.object({ type: z.literal("matching"), data: zMatchingData, ...common }),
]);
export type QuestionInput = z.infer<typeof zQuestionInput>;

// ─── Responses ──────────────────────────────────────────────────────────────

export const zMultichoiceResponse = z.object({ selected: z.array(zShortId).max(26) });
export const zTruefalseResponse = z.object({ value: z.boolean() });
export const zTextResponse = z.object({ text: z.string().max(100_000) });
export const zNumericalResponse = z.object({ value: z.string().max(100) });
/** questionPairId → chosen answer text (answers are offered as distinct texts, so ids never leak the mapping). */
export const zMatchingResponse = z.object({ matches: z.record(zShortId, z.string().max(500)) });

export const RESPONSE_SCHEMAS = {
  multichoice: zMultichoiceResponse,
  truefalse: zTruefalseResponse,
  shortanswer: zTextResponse,
  numerical: zNumericalResponse,
  essay: zTextResponse,
  matching: zMatchingResponse,
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

/**
 * Grades one response. `fraction` is 0..1; `null` means it needs manual grading.
 * A missing/invalid response scores 0 (an empty essay is not sent for manual grading).
 */
export function gradeResponse(type: QuestionType, data: unknown, response: unknown): GradeResult {
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
  }
}

// ─── Attempt variants (shuffling) and learner-safe views ────────────────────

export type Variant = { order?: string[]; stems?: string[]; choices?: string[] };

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
  return {};
}

/** What a learner may see of a question while attempting it — never fractions, answers or feedback. */
export type StudentView =
  | { type: "multichoice"; single: boolean; options: { id: string; text: string }[] }
  | { type: "truefalse" }
  | { type: "shortanswer" }
  | { type: "numerical" }
  | { type: "essay"; responseTemplate: string | null; minWords: number | null }
  | { type: "matching"; stems: { id: string; text: string }[]; choices: string[] };

export function studentView(type: QuestionType, data: unknown, variant: Variant): StudentView {
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
    default:
      return { type } as StudentView;
  }
}

/** Human-readable correct answer, shown in review when `rightAnswer` is enabled. */
export function rightAnswerText(type: QuestionType, data: unknown): string | null {
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
