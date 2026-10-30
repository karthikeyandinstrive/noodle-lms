import { and, asc, count, eq, gt, inArray, isNull, lte, max } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { attemptAnswers, questionCategories, questions, questionVersions, quizAttempts, quizSlots, quizzes, type DB } from "@lms/db";
import { z } from "zod";
import { registerActivityType, type ActivityRow } from "../../core/activity-types";
import { badRequest, conflict, forbidden, must, notFound } from "../../core/errors";
import type { EventMap, EventName } from "../../core/events";
import { hasCapability } from "../../core/rbac";
import { cleanHtml } from "../../core/sanitize";
import { zDateInput } from "../../core/schemas";
import { loadActivity } from "../activities/service";
import { pushGrade } from "../gradebook/service";
import { aggregateGrade, attemptDueAt, attemptTotals, canStartAttempt, isOverdue, markFor, type GradeMethod } from "./grading";
import { gradeResponse, makeVariant, shuffle, type QuestionType, type Variant } from "./question-types";

export type QuizRow = typeof quizzes.$inferSelect;
export type AttemptRow = typeof quizAttempts.$inferSelect;

/** Events collected inside a transaction and emitted after it commits. */
export type PendingEvent = { [K in EventName]: { name: K; payload: EventMap[K] } }[EventName];

/**
 * Preview attempts (teachers/editors with quiz:preview but without quiz:attempt)
 * are stored with attempt number 0. They never count towards the attempt limit,
 * never reach the gradebook, are excluded from reports, and the previous preview
 * is replaced when a new one starts. No schema change needed and the flag is
 * queryable (`attempt <= 0`).
 */
export const PREVIEW_ATTEMPT = 0;
export const isPreview = (a: Pick<AttemptRow, "attempt">) => a.attempt <= PREVIEW_ATTEMPT;

// ─── Activity type ──────────────────────────────────────────────────────────

const zReviewOptions = z.object({ marks: z.boolean(), correctness: z.boolean(), feedback: z.boolean(), rightAnswer: z.boolean() });

export const quizSettings = z.object({
  intro: z.string().max(50_000).nullable().optional(),
  openAt: zDateInput.nullable().optional(),
  closeAt: zDateInput.nullable().optional(),
  /** null/0 = no time limit */
  timeLimitSeconds: z
    .number()
    .int()
    .min(0)
    .max(7 * 24 * 3600)
    .nullable()
    .optional(),
  /** 0 = unlimited */
  attemptsAllowed: z.number().int().min(0).max(100).default(0),
  gradeMethod: z.enum(["highest", "average", "first", "last"]).default("highest"),
  gradeMax: z.number().positive().max(10_000).default(10),
  gradePass: z.number().min(0).max(10_000).nullable().optional(),
  shuffleQuestions: z.boolean().default(false),
  shuffleAnswers: z.boolean().default(true),
  reviewOptions: zReviewOptions.default({ marks: true, correctness: true, feedback: true, rightAnswer: false }),
});
type QuizSettings = z.infer<typeof quizSettings>;

function normalise(s: Partial<QuizSettings>) {
  const out: Partial<typeof quizzes.$inferInsert> = {};
  if (s.intro !== undefined) out.intro = s.intro ? cleanHtml(s.intro) : null;
  if (s.openAt !== undefined) out.openAt = s.openAt;
  if (s.closeAt !== undefined) out.closeAt = s.closeAt;
  if (s.timeLimitSeconds !== undefined) out.timeLimitSeconds = s.timeLimitSeconds || null;
  if (s.attemptsAllowed !== undefined) out.attemptsAllowed = s.attemptsAllowed;
  if (s.gradeMethod !== undefined) out.gradeMethod = s.gradeMethod;
  if (s.gradeMax !== undefined) out.gradeMax = s.gradeMax;
  if (s.gradePass !== undefined) out.gradePass = s.gradePass;
  if (s.shuffleQuestions !== undefined) out.shuffleQuestions = s.shuffleQuestions;
  if (s.shuffleAnswers !== undefined) out.shuffleAnswers = s.shuffleAnswers;
  if (s.reviewOptions !== undefined) out.reviewOptions = s.reviewOptions;
  return out;
}

function validate(q: { openAt?: Date | null; closeAt?: Date | null; gradeMax?: number; gradePass?: number | null }) {
  if (q.openAt && q.closeAt && q.closeAt <= q.openAt) throw badRequest("The close date must be after the open date");
  if (q.gradePass != null && q.gradeMax != null && q.gradePass > q.gradeMax) throw badRequest("The pass grade cannot exceed the maximum grade");
}

export async function quizOf(tx: DB, activityId: string) {
  return must((await tx.select().from(quizzes).where(eq(quizzes.activityId, activityId)).limit(1))[0], "Quiz");
}

export function registerQuizType() {
  registerActivityType({
    type: "quiz",
    label: "Quiz",
    settings: quizSettings,
    async create(tx, ctx, settings) {
      const values = normalise(settings);
      validate(values);
      await tx.insert(quizzes).values({ ...values, organizationId: ctx.organizationId, activityId: ctx.activity.id });
    },
    async update(tx, ctx, settings) {
      const current = await quizOf(tx, ctx.activity.id);
      const patch = normalise(settings);
      validate({ ...current, ...patch });
      if (Object.keys(patch).length) await tx.update(quizzes).set(patch).where(eq(quizzes.id, current.id));
    },
    async load(tx, activity) {
      const [q] = await tx.select().from(quizzes).where(eq(quizzes.activityId, activity.id)).limit(1);
      if (!q) return null;
      return {
        intro: q.intro,
        openAt: q.openAt?.toISOString() ?? null,
        closeAt: q.closeAt?.toISOString() ?? null,
        timeLimitSeconds: q.timeLimitSeconds,
        attemptsAllowed: q.attemptsAllowed,
        gradeMethod: q.gradeMethod,
        gradeMax: q.gradeMax,
        gradePass: q.gradePass,
        shuffleQuestions: q.shuffleQuestions,
        shuffleAnswers: q.shuffleAnswers,
        reviewOptions: q.reviewOptions,
      };
    },
    async grading(tx, activity) {
      const q = await quizOf(tx, activity.id);
      return { gradeMax: q.gradeMax, gradePass: q.gradePass };
    },
  });
}

// ─── Loading ────────────────────────────────────────────────────────────────

export async function loadQuiz(tx: DB, req: FastifyRequest, activityId: string, opts: Parameters<typeof loadActivity>[3] = {}) {
  const { activity, course, canEdit } = await loadActivity(tx, req, activityId, { ...opts, type: "quiz" });
  return { activity, course, canEdit, quiz: await quizOf(tx, activity.id) };
}

/** Loads an attempt of this quiz that the user owns, or any attempt when they can view reports. */
export async function loadAttempt(tx: DB, req: FastifyRequest, quiz: QuizRow, activity: ActivityRow, attemptId: string) {
  const attempt = (
    await tx
      .select()
      .from(quizAttempts)
      .where(and(eq(quizAttempts.id, attemptId), eq(quizAttempts.quizId, quiz.id)))
      .limit(1)
  )[0];
  if (!attempt) throw notFound("Attempt");
  const owner = attempt.userId === req.user?.id;
  const reviewer = await hasCapability(tx, req, "quiz:view_reports", activity.contextId);
  if (!owner && !reviewer) throw notFound("Attempt");
  return { attempt, owner, reviewer };
}

export async function slotsOf(tx: DB, quizId: string) {
  return tx.select().from(quizSlots).where(eq(quizSlots.quizId, quizId)).orderBy(asc(quizSlots.position));
}

/** A category's id plus, when asked, all its descendants' ids. */
export async function categoryWithDescendants(tx: DB, categoryId: string, includeSubcategories: boolean) {
  const ids = [categoryId];
  if (!includeSubcategories) return ids;
  const [cat] = await tx.select({ courseId: questionCategories.courseId }).from(questionCategories).where(eq(questionCategories.id, categoryId)).limit(1);
  if (!cat) return ids;
  // Categories of the same bank (course or shared), walked breadth-first.
  const all = await tx
    .select({ id: questionCategories.id, parentId: questionCategories.parentId })
    .from(questionCategories)
    .where(cat.courseId ? eq(questionCategories.courseId, cat.courseId) : isNull(questionCategories.courseId));
  for (let i = 0; i < ids.length; i++) for (const c of all) if (c.parentId === ids[i] && !ids.includes(c.id)) ids.push(c.id);
  return ids;
}

/** Live (not deleted) questions a random slot can draw from. */
export async function randomCandidates(tx: DB, categoryId: string, includeSubcategories: boolean) {
  const cats = await categoryWithDescendants(tx, categoryId, includeSubcategories);
  return tx
    .select({ id: questions.id, latestVersion: questions.latestVersion })
    .from(questions)
    .where(and(inArray(questions.categoryId, cats), isNull(questions.deletedAt)));
}

/** Answers of an attempt joined with the frozen question version, in the attempt's layout order. */
export async function answersOf(tx: DB, attempt: AttemptRow) {
  const rows = await tx
    .select({ answer: attemptAnswers, version: questionVersions })
    .from(attemptAnswers)
    .innerJoin(questionVersions, eq(questionVersions.id, attemptAnswers.questionVersionId))
    .where(eq(attemptAnswers.attemptId, attempt.id));
  const pos = new Map(attempt.layout.map((id, i) => [id, i]));
  return rows.sort((a, b) => (pos.get(a.answer.slotId) ?? 1e9) - (pos.get(b.answer.slotId) ?? 1e9));
}

export async function hasRealAttempts(tx: DB, quizId: string) {
  const [row] = await tx
    .select({ id: quizAttempts.id })
    .from(quizAttempts)
    .where(and(eq(quizAttempts.quizId, quizId), gt(quizAttempts.attempt, PREVIEW_ATTEMPT)))
    .limit(1);
  return !!row;
}

/** Structural edits (add/remove questions, marks, pinned versions) are locked once students have attempted. */
export async function assertEditable(tx: DB, quiz: QuizRow) {
  if (await hasRealAttempts(tx, quiz.id)) throw conflict("This quiz has been attempted: questions and marks can no longer be changed");
  // Previews are disposable; drop them so they never reference a stale structure.
  await tx.delete(quizAttempts).where(and(eq(quizAttempts.quizId, quiz.id), lte(quizAttempts.attempt, PREVIEW_ATTEMPT)));
}

// ─── Grades ─────────────────────────────────────────────────────────────────

/** Recomputes the learner's quiz grade from their finished attempts and pushes it to the gradebook. */
export async function syncQuizGrade(tx: DB, quiz: QuizRow, activity: ActivityRow, userId: string, gradedBy?: string | null, clearIfNone = false) {
  const finished = await tx
    .select({ attempt: quizAttempts.attempt, grade: quizAttempts.grade })
    .from(quizAttempts)
    .where(
      and(eq(quizAttempts.quizId, quiz.id), eq(quizAttempts.userId, userId), eq(quizAttempts.status, "finished"), gt(quizAttempts.attempt, PREVIEW_ATTEMPT)),
    );
  const grade = aggregateGrade(quiz.gradeMethod as GradeMethod, finished);
  if (grade === null && !clearIfNone) return null;
  return pushGrade(tx, {
    organizationId: activity.organizationId,
    activityId: activity.id,
    userId,
    rawGrade: grade,
    gradedBy: gradedBy ?? null,
    source: "quiz",
  });
}

/** Re-totals an attempt from its answers (after finishing or manual grading). */
export async function retotalAttempt(tx: DB, quiz: QuizRow, attempt: AttemptRow) {
  const answers = await tx
    .select({ mark: attemptAnswers.mark, maxMark: attemptAnswers.maxMark, needsGrading: attemptAnswers.needsGrading })
    .from(attemptAnswers)
    .where(eq(attemptAnswers.attemptId, attempt.id));
  const totals = attemptTotals(answers, quiz.gradeMax);
  const [updated] = await tx
    .update(quizAttempts)
    .set({ sumMarks: totals.sumMarks, grade: totals.grade, needsGrading: totals.needsGrading })
    .where(eq(quizAttempts.id, attempt.id))
    .returning();
  return updated!;
}

// ─── Attempt lifecycle ──────────────────────────────────────────────────────

/** Auto-grades every answer, totals the attempt and updates the gradebook. Returns events to emit after commit. */
export async function finishAttempt(
  tx: DB,
  quiz: QuizRow,
  activity: ActivityRow,
  attempt: AttemptRow,
): Promise<{ attempt: AttemptRow; events: PendingEvent[] }> {
  // Lock the attempt row: concurrent finish requests grade only once.
  const [locked] = await tx.select().from(quizAttempts).where(eq(quizAttempts.id, attempt.id)).for("update");
  if (!locked || locked.status !== "in_progress") return { attempt: locked ?? attempt, events: [] };

  const rows = await answersOf(tx, locked);
  for (const { answer, version } of rows) {
    const { fraction } = gradeResponse(version.type as QuestionType, version.data, answer.response, { variant: answer.variant as Variant, text: version.text });
    await tx
      .update(attemptAnswers)
      .set({ fraction, mark: markFor(fraction, answer.maxMark), needsGrading: fraction === null })
      .where(eq(attemptAnswers.id, answer.id));
  }
  await tx.update(quizAttempts).set({ status: "finished", finishedAt: new Date() }).where(eq(quizAttempts.id, locked.id));
  const finished = await retotalAttempt(tx, quiz, { ...locked, status: "finished" });

  const events: PendingEvent[] = [];
  if (!isPreview(finished)) {
    const base = { organizationId: activity.organizationId, activityId: activity.id, courseId: activity.courseId, userId: finished.userId };
    events.push({ name: "quiz.attempt_submitted", payload: { ...base, attemptId: finished.id } });
    events.push({ name: "activity.submitted", payload: base });
    const grade = await syncQuizGrade(tx, quiz, activity, finished.userId);
    if (grade) events.push({ name: "grade.updated", payload: grade });
  }
  return { attempt: finished, events };
}

/** Finishes the attempt if its deadline (plus grace) has passed. */
export async function closeIfOverdue(tx: DB, quiz: QuizRow, activity: ActivityRow, attempt: AttemptRow, now = new Date()) {
  if (attempt.status === "in_progress" && isOverdue(attempt.dueAt, now)) return finishAttempt(tx, quiz, activity, attempt);
  return { attempt, events: [] as PendingEvent[] };
}

/** Auto-finishes all of a user's overdue in-progress attempts of a quiz. */
export async function closeOverdueFor(tx: DB, quiz: QuizRow, activity: ActivityRow, userId: string) {
  const open = await tx
    .select()
    .from(quizAttempts)
    .where(and(eq(quizAttempts.quizId, quiz.id), eq(quizAttempts.userId, userId), eq(quizAttempts.status, "in_progress")));
  const events: PendingEvent[] = [];
  for (const a of open) events.push(...(await closeIfOverdue(tx, quiz, activity, a)).events);
  return events;
}

export async function startAttempt(tx: DB, req: FastifyRequest, quiz: QuizRow, activity: ActivityRow) {
  const userId = req.user!.id;
  const canAttempt = await hasCapability(tx, req, "quiz:attempt", activity.contextId);
  const canPreview = await hasCapability(tx, req, "quiz:preview", activity.contextId);
  if (!canAttempt && !canPreview) throw forbidden();
  const preview = !canAttempt;
  const events = await closeOverdueFor(tx, quiz, activity, userId);

  // One in-progress attempt at a time: continue it instead of starting another.
  const [current] = await tx
    .select()
    .from(quizAttempts)
    .where(and(eq(quizAttempts.quizId, quiz.id), eq(quizAttempts.userId, userId), eq(quizAttempts.status, "in_progress")))
    .limit(1);
  if (current) return { attempt: current, events, resumed: true };

  const now = new Date();
  let attemptNo = PREVIEW_ATTEMPT;
  if (preview) {
    await tx.delete(quizAttempts).where(and(eq(quizAttempts.quizId, quiz.id), eq(quizAttempts.userId, userId), lte(quizAttempts.attempt, PREVIEW_ATTEMPT)));
  } else {
    const done = await tx
      .select({ n: max(quizAttempts.attempt), total: count() })
      .from(quizAttempts)
      .where(and(eq(quizAttempts.quizId, quiz.id), eq(quizAttempts.userId, userId), gt(quizAttempts.attempt, PREVIEW_ATTEMPT)));
    const lastNo = done[0]?.n ?? 0;
    // The limit counts existing attempts (a grader may have deleted some); numbering continues from the highest.
    const allowed = canStartAttempt(quiz, Number(done[0]?.total ?? 0), now);
    if (!allowed.ok) throw conflict(allowed.reason);
    attemptNo = lastNo + 1;
  }

  const slots = await slotsOf(tx, quiz.id);
  if (!slots.length) throw conflict("This quiz has no questions yet");

  // Random slots draw a question now, never one already in this attempt.
  const questionOf = new Map<string, string>();
  const used = new Set(slots.flatMap((s) => (s.questionId ? [s.questionId] : [])));
  for (const slot of slots) {
    if (slot.questionId) {
      questionOf.set(slot.id, slot.questionId);
      continue;
    }
    const pool = (await randomCandidates(tx, slot.randomCategoryId!, slot.randomIncludeSubcategories)).filter((q) => !used.has(q.id));
    if (!pool.length) throw conflict("A random question in this quiz has no unused questions left in its category; ask your teacher to fix the quiz");
    const pick = pool[Math.floor(Math.random() * pool.length)]!;
    used.add(pick.id);
    questionOf.set(slot.id, pick.id);
  }

  // Freeze the exact question version per slot.
  const qs = await tx
    .select()
    .from(questions)
    .where(inArray(questions.id, [...new Set(questionOf.values())]));
  const latestOf = new Map(qs.map((q) => [q.id, q.latestVersion]));
  const versionRows = await tx
    .select()
    .from(questionVersions)
    .where(inArray(questionVersions.questionId, [...latestOf.keys()]));
  const versionFor = (slot: (typeof slots)[number]) => {
    const questionId = questionOf.get(slot.id)!;
    const wanted = slot.pinnedVersion ?? latestOf.get(questionId);
    return versionRows.find((v) => v.questionId === questionId && v.version === wanted);
  };

  const layout = quiz.shuffleQuestions ? shuffle(slots.map((s) => s.id)) : slots.map((s) => s.id);
  const dueAt = attemptDueAt(now, quiz.timeLimitSeconds, preview ? null : quiz.closeAt);

  const [attempt] = await tx
    .insert(quizAttempts)
    .values({ organizationId: quiz.organizationId, quizId: quiz.id, userId, attempt: attemptNo, status: "in_progress", layout, startedAt: now, dueAt })
    .returning();
  await tx.insert(attemptAnswers).values(
    slots.map((slot) => {
      const v = versionFor(slot);
      if (!v) throw conflict("A question in this quiz is missing; ask your teacher to fix the quiz");
      return {
        organizationId: quiz.organizationId,
        attemptId: attempt!.id,
        slotId: slot.id,
        questionVersionId: v.id,
        variant: makeVariant(v.type as QuestionType, v.data, quiz.shuffleAnswers) as Record<string, unknown>,
        response: null,
        maxMark: slot.maxMark,
      };
    }),
  );
  if (!preview) {
    events.push({
      name: "quiz.attempt_started",
      payload: { organizationId: quiz.organizationId, activityId: activity.id, courseId: activity.courseId, userId, attemptId: attempt!.id },
    });
  }
  return { attempt: attempt!, events, resumed: false };
}
