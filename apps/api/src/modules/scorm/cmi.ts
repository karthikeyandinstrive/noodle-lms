/**
 * SCORM run-time data model (CMI) rules — pure functions, unit-tested in scorm.test.ts.
 *
 * The browser keeps the CMI in memory and commits the elements the SCO wrote. The server
 * only accepts writable elements of the package's SCORM version, validates their values
 * (vocabularies, numbers, time formats, lengths) and derives the normalized status,
 * score and time used for reporting and grading.
 */
import type { ScormVersion } from "./manifest";

export type Cmi = Record<string, string>;

export const SUSPEND_DATA_MAX = { "1.2": 4096, "2004": 64_000 } as const;
const MAX_COLLECTION = { objectives: 100, interactions: 250, comments: 100, patterns: 50 } as const;

type Rule = { pattern: RegExp; check: (v: string) => boolean };

const rx = (re: RegExp) => (v: string) => re.test(v);
const oneOf = (...values: string[]) => (v: string) => values.includes(v);
const maxLen = (n: number) => (v: string) => v.length <= n;
const decimal = (min = -Infinity, max = Infinity, allowBlank = false) => (v: string) => {
  if (v === "") return allowBlank;
  if (!/^-?\d+(\.\d+)?$/.test(v.trim())) return false;
  const n = Number(v);
  return n >= min && n <= max;
};
const integer = (min: number, max: number) => (v: string) => /^-?\d+$/.test(v) && Number(v) >= min && Number(v) <= max;

// ─── Time formats ───────────────────────────────────────────────────────────

/** SCORM 1.2 CMITimespan: HHHH:MM:SS(.SS) → seconds, or null when malformed. */
export function parseTimespan12(v: string): number | null {
  const m = /^(\d{2,4}):([0-5]\d):([0-5]\d)(\.\d{1,2})?$/.exec(v.trim());
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + (m[4] ? Number(m[4]) : 0);
}

/** SCORM 2004 timeinterval (ISO 8601 duration, e.g. PT1H2M3.5S, P1DT2H) → seconds, or null. */
export function parseDuration2004(v: string): number | null {
  const m = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d{1,2})?)S)?)?$/.exec(v.trim());
  if (!m || v.trim() === "P" || v.trim().endsWith("T")) return null;
  const [, y, mo, d, h, mi, s] = m;
  return (
    Number(y ?? 0) * 365 * 86400 + Number(mo ?? 0) * 30 * 86400 + Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(mi ?? 0) * 60 + Number(s ?? 0)
  );
}

export const parseSessionTime = (version: ScormVersion, v: string) => (version === "1.2" ? parseTimespan12(v) : parseDuration2004(v));

/** Seconds → "HHHH:MM:SS.SS" (1.2 cmi.core.total_time). */
export function formatTimespan12(seconds: number) {
  const total = Math.max(0, Math.round(seconds * 100) / 100);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total - h * 3600 - m * 60;
  const pad = (n: number, w: number) => String(n).padStart(w, "0");
  const sec = s.toFixed(2).padStart(5, "0");
  return `${pad(Math.min(h, 9999), 4)}:${pad(m, 2)}:${sec}`;
}

/** Seconds → ISO 8601 duration (2004 cmi.total_time), e.g. PT1H2M3.5S. */
export function formatDuration2004(seconds: number) {
  const total = Math.max(0, Math.round(seconds * 100) / 100);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.round((total - h * 3600 - m * 60) * 100) / 100;
  return `PT${h ? `${h}H` : ""}${m ? `${m}M` : ""}${s || (!h && !m) ? `${s}S` : ""}`;
}

export const formatTotalTime = (version: ScormVersion, seconds: number) => (version === "1.2" ? formatTimespan12(seconds) : formatDuration2004(seconds));

const isTimespan12 = (v: string) => parseTimespan12(v) !== null;
const isDuration = (v: string) => parseDuration2004(v) !== null;
const isTime12 = rx(/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,2})?$/);
const isTimestamp2004 = rx(/^\d{4}(-\d{2}(-\d{2}(T\d{2}(:\d{2}(:\d{2}(\.\d{1,2})?)?)?(Z|[+-]\d{2}(:\d{2})?)?)?)?)?$/);

// ─── Writable elements per version ──────────────────────────────────────────

/** Element path → regex; each "n" segment is a collection index. */
const el = (path: string) =>
  new RegExp(`^${path.split(".").map((p) => (p === "n" ? "\\d{1,3}" : p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("\\.")}$`);

const STATUS_12 = ["passed", "completed", "failed", "incomplete", "browsed"];
const INTERACTION_TYPES_12 = ["true-false", "choice", "fill-in", "matching", "performance", "sequencing", "likert", "numeric"];
const RESULT_12 = (v: string) => ["correct", "wrong", "unanticipated", "neutral"].includes(v) || decimal()(v);

const RULES_12: Rule[] = [
  { pattern: el("cmi.core.lesson_location"), check: maxLen(255) },
  { pattern: el("cmi.core.lesson_status"), check: oneOf(...STATUS_12) },
  { pattern: el("cmi.core.score.raw"), check: decimal(0, 100, true) },
  { pattern: el("cmi.core.score.max"), check: decimal(0, 100, true) },
  { pattern: el("cmi.core.score.min"), check: decimal(0, 100, true) },
  { pattern: el("cmi.core.exit"), check: oneOf("time-out", "suspend", "logout", "") },
  { pattern: el("cmi.core.session_time"), check: isTimespan12 },
  { pattern: el("cmi.suspend_data"), check: maxLen(SUSPEND_DATA_MAX["1.2"]) },
  { pattern: el("cmi.comments"), check: maxLen(4096) },
  { pattern: el("cmi.objectives.n.id"), check: rx(/^.{1,255}$/s) },
  { pattern: el("cmi.objectives.n.score.raw"), check: decimal(0, 100, true) },
  { pattern: el("cmi.objectives.n.score.max"), check: decimal(0, 100, true) },
  { pattern: el("cmi.objectives.n.score.min"), check: decimal(0, 100, true) },
  { pattern: el("cmi.objectives.n.status"), check: oneOf(...STATUS_12, "not attempted") },
  { pattern: el("cmi.student_preference.audio"), check: integer(-1, 100) },
  { pattern: el("cmi.student_preference.language"), check: maxLen(255) },
  { pattern: el("cmi.student_preference.speed"), check: integer(-100, 100) },
  { pattern: el("cmi.student_preference.text"), check: integer(-1, 1) },
  { pattern: el("cmi.interactions.n.id"), check: rx(/^.{1,255}$/s) },
  { pattern: el("cmi.interactions.n.objectives.n.id"), check: rx(/^.{1,255}$/s) },
  { pattern: el("cmi.interactions.n.time"), check: isTime12 },
  { pattern: el("cmi.interactions.n.type"), check: oneOf(...INTERACTION_TYPES_12) },
  { pattern: el("cmi.interactions.n.correct_responses.n.pattern"), check: maxLen(255) },
  { pattern: el("cmi.interactions.n.weighting"), check: decimal() },
  { pattern: el("cmi.interactions.n.student_response"), check: maxLen(255) },
  { pattern: el("cmi.interactions.n.result"), check: RESULT_12 },
  { pattern: el("cmi.interactions.n.latency"), check: isTimespan12 },
];

const COMPLETION_2004 = ["completed", "incomplete", "not attempted", "unknown"];
const SUCCESS_2004 = ["passed", "failed", "unknown"];
const INTERACTION_TYPES_2004 = ["true-false", "choice", "fill-in", "long-fill-in", "matching", "performance", "sequencing", "likert", "numeric", "other"];
const RESULT_2004 = (v: string) => ["correct", "incorrect", "unanticipated", "neutral"].includes(v) || decimal()(v);
const NAV_REQUEST = /^(continue|previous|exit|exitAll|abandon|abandonAll|suspendAll|_none_|\{target=[^}]{1,4000}\}(choice|jump))$/;

const RULES_2004: Rule[] = [
  { pattern: el("cmi.comments_from_learner.n.comment"), check: maxLen(4000) },
  { pattern: el("cmi.comments_from_learner.n.location"), check: maxLen(250) },
  { pattern: el("cmi.comments_from_learner.n.timestamp"), check: isTimestamp2004 },
  { pattern: el("cmi.completion_status"), check: oneOf(...COMPLETION_2004) },
  { pattern: el("cmi.exit"), check: oneOf("time-out", "suspend", "logout", "normal", "") },
  { pattern: el("cmi.interactions.n.id"), check: rx(/^.{1,4000}$/s) },
  { pattern: el("cmi.interactions.n.type"), check: oneOf(...INTERACTION_TYPES_2004) },
  { pattern: el("cmi.interactions.n.objectives.n.id"), check: rx(/^.{1,4000}$/s) },
  { pattern: el("cmi.interactions.n.timestamp"), check: isTimestamp2004 },
  { pattern: el("cmi.interactions.n.correct_responses.n.pattern"), check: maxLen(8000) },
  { pattern: el("cmi.interactions.n.weighting"), check: decimal() },
  { pattern: el("cmi.interactions.n.learner_response"), check: maxLen(8000) },
  { pattern: el("cmi.interactions.n.result"), check: RESULT_2004 },
  { pattern: el("cmi.interactions.n.latency"), check: isDuration },
  { pattern: el("cmi.interactions.n.description"), check: maxLen(500) },
  { pattern: el("cmi.learner_preference.audio_level"), check: decimal(0) },
  { pattern: el("cmi.learner_preference.language"), check: maxLen(250) },
  { pattern: el("cmi.learner_preference.delivery_speed"), check: decimal(0) },
  { pattern: el("cmi.learner_preference.audio_captioning"), check: oneOf("-1", "0", "1") },
  { pattern: el("cmi.location"), check: maxLen(1000) },
  { pattern: el("cmi.objectives.n.id"), check: rx(/^.{1,4000}$/s) },
  { pattern: el("cmi.objectives.n.score.scaled"), check: decimal(-1, 1) },
  { pattern: el("cmi.objectives.n.score.raw"), check: decimal() },
  { pattern: el("cmi.objectives.n.score.min"), check: decimal() },
  { pattern: el("cmi.objectives.n.score.max"), check: decimal() },
  { pattern: el("cmi.objectives.n.success_status"), check: oneOf(...SUCCESS_2004) },
  { pattern: el("cmi.objectives.n.completion_status"), check: oneOf(...COMPLETION_2004) },
  { pattern: el("cmi.objectives.n.progress_measure"), check: decimal(0, 1) },
  { pattern: el("cmi.objectives.n.description"), check: maxLen(250) },
  { pattern: el("cmi.progress_measure"), check: decimal(0, 1) },
  { pattern: el("cmi.score.scaled"), check: decimal(-1, 1) },
  { pattern: el("cmi.score.raw"), check: decimal() },
  { pattern: el("cmi.score.min"), check: decimal() },
  { pattern: el("cmi.score.max"), check: decimal() },
  { pattern: el("cmi.session_time"), check: isDuration },
  { pattern: el("cmi.success_status"), check: oneOf(...SUCCESS_2004) },
  { pattern: el("cmi.suspend_data"), check: maxLen(SUSPEND_DATA_MAX["2004"]) },
  { pattern: el("adl.nav.request"), check: rx(NAV_REQUEST) },
];

const RULES = { "1.2": RULES_12, "2004": RULES_2004 } as const;

/** Read-only elements the LMS provides (the runtime returns them; SCOs cannot set them). */
export const READ_ONLY = {
  "1.2": [
    "cmi.core._children",
    "cmi.core.student_id",
    "cmi.core.student_name",
    "cmi.core.credit",
    "cmi.core.entry",
    "cmi.core.total_time",
    "cmi.core.lesson_mode",
    "cmi.core.score._children",
    "cmi.launch_data",
    "cmi.comments_from_lms",
    "cmi.student_data._children",
    "cmi.student_data.mastery_score",
    "cmi.student_data.max_time_allowed",
    "cmi.student_data.time_limit_action",
    "cmi.objectives._children",
    "cmi.objectives._count",
    "cmi.interactions._children",
    "cmi.interactions._count",
    "cmi.student_preference._children",
  ],
  "2004": [
    "cmi._version",
    "cmi.completion_threshold",
    "cmi.credit",
    "cmi.entry",
    "cmi.launch_data",
    "cmi.learner_id",
    "cmi.learner_name",
    "cmi.max_time_allowed",
    "cmi.mode",
    "cmi.scaled_passing_score",
    "cmi.time_limit_action",
    "cmi.total_time",
    "cmi.comments_from_learner._children",
    "cmi.comments_from_learner._count",
    "cmi.comments_from_lms._children",
    "cmi.comments_from_lms._count",
    "cmi.interactions._children",
    "cmi.interactions._count",
    "cmi.objectives._children",
    "cmi.objectives._count",
    "cmi.score._children",
    "cmi.learner_preference._children",
  ],
} as const;

/** Write-only elements: never returned by GetValue (1.2 error 404 / 2004 error 405). */
export const WRITE_ONLY = {
  "1.2": [/^cmi\.core\.exit$/, /^cmi\.core\.session_time$/, /^cmi\.interactions\.\d+\.(?!_count)/],
  "2004": [/^cmi\.exit$/, /^cmi\.session_time$/],
} as const;

export type CmiProblem = { key: string; reason: "unknown" | "read-only" | "invalid" | "index" };

function indexProblem(key: string): boolean {
  for (const [coll, max] of [
    ["objectives", MAX_COLLECTION.objectives],
    ["interactions", MAX_COLLECTION.interactions],
    ["comments_from_learner", MAX_COLLECTION.comments],
  ] as const) {
    const m = new RegExp(`^cmi\\.${coll}\\.(\\d+)\\.`).exec(key);
    if (m && Number(m[1]) >= max) return true;
  }
  const p = /\.(?:correct_responses|objectives)\.(\d+)\./.exec(key.replace(/^cmi\.(objectives|interactions)\.\d+\./, "x."));
  return !!p && Number(p[1]) >= MAX_COLLECTION.patterns;
}

/** Validates elements written by the SCO. Returns the problems (empty = valid). */
export function validateCmi(version: ScormVersion, input: Cmi): CmiProblem[] {
  const problems: CmiProblem[] = [];
  const rules = RULES[version];
  const ro = READ_ONLY[version] as readonly string[];
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== "string") {
      problems.push({ key, reason: "invalid" });
      continue;
    }
    if (ro.includes(key)) {
      problems.push({ key, reason: "read-only" });
      continue;
    }
    const rule = rules.find((r) => r.pattern.test(key));
    if (!rule) problems.push({ key, reason: "unknown" });
    else if (indexProblem(key)) problems.push({ key, reason: "index" });
    else if (!rule.check(value)) problems.push({ key, reason: "invalid" });
  }
  return problems;
}

export const isWritable = (version: ScormVersion, key: string) => RULES[version].some((r) => r.pattern.test(key));

/** Merges a commit into the stored CMI (1.2 cmi.comments is appended, as the spec requires). */
export function mergeCmi(version: ScormVersion, stored: Cmi, input: Cmi): Cmi {
  const out: Cmi = { ...stored };
  for (const [k, v] of Object.entries(input)) {
    if (version === "1.2" && k === "cmi.comments" && stored[k] && v) out[k] = (stored[k] + v).slice(-4096);
    else out[k] = v;
  }
  return out;
}

// ─── Status, score, time ────────────────────────────────────────────────────

export type NormalizedStatus = "not attempted" | "incomplete" | "completed" | "passed" | "failed" | "browsed";
export const FINISHED: NormalizedStatus[] = ["completed", "passed", "failed"];

export type PackageRules = { masteryScore: number | null; scaledPassingScore: number | null; completionThreshold: number | null };

const n = (v: string | undefined) => (v === undefined || v.trim() === "" ? null : Number(v));

/**
 * Normalized attempt status.
 *  - 1.2: cmi.core.lesson_status; with a mastery score and a raw score, the LMS decides passed/failed (RTE 3.4.2).
 *  - 2004: success_status (passed/failed) wins over completion_status; scaled_passing_score and
 *    completion_threshold override what the SCO reported (RTE 4.2.4 / 4.2.22).
 */
export function computeStatus(version: ScormVersion, cmi: Cmi, rules: PackageRules): NormalizedStatus {
  if (version === "1.2") {
    const status = cmi["cmi.core.lesson_status"] ?? "not attempted";
    const raw = n(cmi["cmi.core.score.raw"]);
    if (rules.masteryScore !== null && raw !== null && ["completed", "incomplete", "passed", "failed"].includes(status)) {
      return raw >= rules.masteryScore ? "passed" : "failed";
    }
    return (STATUS_12.includes(status) ? status : "not attempted") as NormalizedStatus;
  }
  let success = cmi["cmi.success_status"] ?? "unknown";
  const scaled = n(cmi["cmi.score.scaled"]);
  if (rules.scaledPassingScore !== null && scaled !== null) success = scaled >= rules.scaledPassingScore ? "passed" : "failed";
  let completion = cmi["cmi.completion_status"] ?? "unknown";
  const progress = n(cmi["cmi.progress_measure"]);
  if (rules.completionThreshold !== null && progress !== null) completion = progress >= rules.completionThreshold ? "completed" : "incomplete";
  if (success === "passed") return "passed";
  if (success === "failed") return "failed";
  if (completion === "completed") return "completed";
  if (completion === "incomplete") return "incomplete";
  return "not attempted";
}

/** Score as raw/max for storage (ratio = raw / max). 2004 prefers cmi.score.scaled. */
export function computeScore(version: ScormVersion, cmi: Cmi): { raw: number; max: number } | null {
  if (version === "2004") {
    const scaled = n(cmi["cmi.score.scaled"]);
    if (scaled !== null && Number.isFinite(scaled)) return { raw: Math.max(0, Math.min(1, scaled)) * 100, max: 100 };
    const raw = n(cmi["cmi.score.raw"]);
    const max = n(cmi["cmi.score.max"]);
    const min = n(cmi["cmi.score.min"]) ?? 0;
    if (raw === null || !Number.isFinite(raw)) return null;
    if (max !== null && max > min) return { raw: Math.max(0, Math.min(max - min, raw - min)), max: max - min };
    return { raw: Math.max(0, Math.min(100, raw)), max: 100 };
  }
  const raw = n(cmi["cmi.core.score.raw"]);
  if (raw === null || !Number.isFinite(raw)) return null;
  const max = n(cmi["cmi.core.score.max"]);
  const realMax = max !== null && max > 0 ? max : 100;
  return { raw: Math.max(0, Math.min(realMax, raw)), max: realMax };
}

export const sessionTimeKey = (version: ScormVersion) => (version === "1.2" ? "cmi.core.session_time" : "cmi.session_time");
export const exitKey = (version: ScormVersion) => (version === "1.2" ? "cmi.core.exit" : "cmi.exit");

// ─── Grade aggregation across attempts ──────────────────────────────────────

export type GradeMethod = "highest" | "average" | "first" | "last";
export const GRADE_METHODS: GradeMethod[] = ["highest", "average", "first", "last"];

/**
 * Aggregates attempt scores (ratios 0..1, null = unscored) into one ratio.
 * Attempts must be ordered by attempt number. Unscored attempts are ignored except for
 * "first", which uses the first attempt as-is (Moodle semantics).
 */
export function aggregateGrade(method: GradeMethod, ratios: (number | null)[]): number | null {
  const scored = ratios.filter((r): r is number => r !== null);
  if (method === "first") return ratios.length ? (ratios[0] ?? null) : null;
  if (!scored.length) return null;
  if (method === "highest") return Math.max(...scored);
  if (method === "last") return scored[scored.length - 1]!;
  return scored.reduce((a, b) => a + b, 0) / scored.length;
}

export const ratioOf = (a: { scoreRaw: number | null; scoreMax: number | null }) =>
  a.scoreRaw === null || a.scoreMax === null || a.scoreMax <= 0 ? null : Math.max(0, Math.min(1, a.scoreRaw / a.scoreMax));
