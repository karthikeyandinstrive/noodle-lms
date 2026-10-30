import { and, asc, eq, gt, inArray } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { attemptAnswers, questionCategories, questions, questionVersions, quizAttempts, quizSlots, users, type DB } from "@lms/db";
import { z } from "zod";
import { requireUser } from "../../core/auth";
import { audit } from "../../core/audit";
import { badRequest, conflict, must, notFound } from "../../core/errors";
import { emit } from "../../core/events";
import { notify } from "../../core/notify";
import { capabilityMap, hasCapability, requireCapability } from "../../core/rbac";
import { cleanHtml } from "../../core/sanitize";
import { ok, zDate, zId, zNullableDate, zOk } from "../../core/schemas";
import { loadCategory } from "../questionbank/service";
import { aggregateGrade, canStartAttempt, facilityIndex, isOverdue, round5, type GradeMethod } from "./grading";
import { presentQuestion, visibilityFor } from "./present";
import {
  QUESTION_TYPES,
  zGapselectResponse,
  zMatchingResponse,
  zMultichoiceResponse,
  zNumericalResponse,
  zTextResponse,
  zTruefalseResponse,
  parseResponse,
  type QuestionType,
} from "./question-types";
import {
  answersOf,
  assertEditable,
  closeIfOverdue,
  closeOverdueFor,
  finishAttempt,
  hasRealAttempts,
  isPreview,
  loadAttempt,
  loadQuiz,
  PREVIEW_ATTEMPT,
  retotalAttempt,
  randomCandidates,
  slotsOf,
  startAttempt,
  syncQuizGrade,
  type PendingEvent,
} from "./service";

// ─── Schemas ────────────────────────────────────────────────────────────────

const zShortId = z.string();
/** Learner-safe question views — the only shapes that can ever be serialized to the client. */
const zView = z.discriminatedUnion("type", [
  z.object({ type: z.literal("multichoice"), single: z.boolean(), options: z.array(z.object({ id: zShortId, text: z.string() })) }),
  z.object({ type: z.literal("truefalse") }),
  z.object({ type: z.literal("shortanswer") }),
  z.object({ type: z.literal("numerical") }),
  z.object({ type: z.literal("essay"), responseTemplate: z.string().nullable(), minWords: z.number().nullable() }),
  z.object({ type: z.literal("matching"), stems: z.array(z.object({ id: zShortId, text: z.string() })), choices: z.array(z.string()) }),
  z.object({ type: z.literal("calculated") }),
  z.object({ type: z.literal("gapselect"), gaps: z.array(z.object({ id: z.string(), options: z.array(z.string()) })) }),
]);
const zResponse = z.union([zMultichoiceResponse, zTruefalseResponse, zTextResponse, zNumericalResponse, zMatchingResponse, zGapselectResponse]).nullable();

const zAttemptQuestion = z.object({
  slotId: zId,
  number: z.number().int(),
  type: z.enum(QUESTION_TYPES),
  name: z.string().optional(),
  text: z.string(),
  maxMark: z.number(),
  view: zView,
  response: zResponse,
  state: z.enum(["correct", "partial", "incorrect", "needs_grading"]).optional(),
  mark: z.number().nullable().optional(),
  feedback: z.string().nullable().optional(),
  generalFeedback: z.string().nullable().optional(),
  comment: z.string().nullable().optional(),
  rightAnswer: z.string().nullable().optional(),
});

const zAttemptSummary = z.object({
  id: zId,
  attempt: z.number().int(),
  preview: z.boolean(),
  status: z.enum(["in_progress", "finished", "abandoned"]),
  startedAt: zDate,
  dueAt: zNullableDate,
  finishedAt: zNullableDate,
  needsGrading: z.boolean(),
  /** Present only when marks are visible to the viewer. */
  sumMarks: z.number().nullable().optional(),
  grade: z.number().nullable().optional(),
});

const zAttemptDetail = z.object({
  attempt: zAttemptSummary.extend({ totalMarks: z.number(), gradeMax: z.number(), serverNow: zDate }),
  user: z.object({ id: zId, firstName: z.string(), lastName: z.string() }),
  quiz: z.object({ activityId: zId, name: z.string(), courseId: zId }),
  isOwner: z.boolean(),
  isReviewer: z.boolean(),
  canGrade: z.boolean(),
  show: z.object({ marks: z.boolean(), correctness: z.boolean(), feedback: z.boolean(), rightAnswer: z.boolean() }),
  questions: z.array(zAttemptQuestion),
});

const zSummary = z.object({
  intro: z.string().nullable(),
  openAt: zNullableDate,
  closeAt: zNullableDate,
  timeLimitSeconds: z.number().int().nullable(),
  attemptsAllowed: z.number().int(),
  gradeMethod: z.enum(["highest", "average", "first", "last"]),
  gradeMax: z.number(),
  gradePass: z.number().nullable(),
  questionCount: z.number().int(),
  totalMarks: z.number(),
  attempts: z.array(zAttemptSummary),
  inProgressAttemptId: zId.nullable(),
  canStart: z.boolean(),
  reason: z.string().nullable(),
  /** The viewer's next attempt is a preview (not graded). */
  isPreview: z.boolean(),
  /** Quiz grade computed with the grade method (null when hidden or not graded). */
  myGrade: z.number().nullable(),
  capabilities: z.record(z.string(), z.boolean()),
});

const zSlot = z.object({
  id: zId,
  position: z.number().int(),
  /** null for a random slot. */
  questionId: zId.nullable(),
  maxMark: z.number(),
  pinnedVersion: z.number().int().nullable(),
  latestVersion: z.number().int().nullable(),
  name: z.string(),
  type: z.enum(QUESTION_TYPES).nullable(),
  deleted: z.boolean(),
  /** Random slot: the category it draws from and how many questions it can draw from now. */
  random: z.object({ categoryId: zId, categoryName: z.string(), includeSubcategories: z.boolean(), available: z.number().int() }).nullable(),
});

const params = z.object({ activityId: zId });
const attemptParams = params.extend({ attemptId: zId });
const slotParams = params.extend({ slotId: zId });

async function emitAll(events: PendingEvent[]) {
  for (const e of events) await emit(e.name, e.payload as never);
}

export const routes: FastifyPluginAsyncZod = async (app) => {
  // ─── Summary ────────────────────────────────────────────────────────────

  app.get(
    "/:activityId",
    { schema: { tags: ["Quiz"], summary: "Quiz overview for me: my attempts, whether I can start", params, response: { 200: zSummary } } },
    async (req) => {
      const me = requireUser(req);
      const { out, events } = await req.tenant(async (tx) => {
        const { quiz, activity } = await loadQuiz(tx, req, req.params.activityId);
        const events = await closeOverdueFor(tx, quiz, activity, me.id);
        const caps = await capabilityMap(tx, req, ["quiz:attempt", "quiz:preview", "quiz:view_reports", "quiz:grade", "activity:update"], activity.contextId);
        const slots = await slotsOf(tx, quiz.id);
        const mine = await tx
          .select()
          .from(quizAttempts)
          .where(and(eq(quizAttempts.quizId, quiz.id), eq(quizAttempts.userId, me.id)))
          .orderBy(asc(quizAttempts.attempt));
        const preview = !caps["quiz:attempt"];
        const real = mine.filter((a) => !isPreview(a));
        const inProgress = mine.find((a) => a.status === "in_progress") ?? null;
        const showMarks = quiz.reviewOptions.marks || !!caps["quiz:view_reports"];

        let canStart = false;
        let reason: string | null = null;
        if (!caps["quiz:attempt"] && !caps["quiz:preview"]) reason = "You cannot attempt this quiz";
        else if (!slots.length) reason = "This quiz has no questions yet";
        else if (inProgress) canStart = true;
        else if (preview) canStart = true;
        else {
          const r = canStartAttempt(quiz, real.length, new Date());
          canStart = r.ok;
          reason = r.ok ? null : r.reason;
        }

        const finished = real.filter((a) => a.status === "finished");
        return {
          events,
          out: {
            ...quiz,
            questionCount: slots.length,
            totalMarks: round5(slots.reduce((s, x) => s + x.maxMark, 0)),
            attempts: mine.map((a) => ({
              ...a,
              preview: isPreview(a),
              sumMarks: showMarks ? a.sumMarks : undefined,
              grade: showMarks ? a.grade : undefined,
            })),
            inProgressAttemptId: inProgress?.id ?? null,
            canStart,
            reason,
            isPreview: preview,
            myGrade: showMarks ? aggregateGrade(quiz.gradeMethod as GradeMethod, finished) : null,
            capabilities: caps as Record<string, boolean>,
          },
        };
      });
      await emitAll(events);
      return out;
    },
  );

  // ─── Slots (editing) ────────────────────────────────────────────────────

  async function slotList(tx: DB, quizId: string) {
    const slots = await slotsOf(tx, quizId);
    if (!slots.length) return [];
    const questionIds = slots.flatMap((s) => (s.questionId ? [s.questionId] : []));
    const qs = questionIds.length ? await tx.select().from(questions).where(inArray(questions.id, questionIds)) : [];
    const versions = qs.length
      ? await tx
          .select()
          .from(questionVersions)
          .where(
            inArray(
              questionVersions.questionId,
              qs.map((q) => q.id),
            ),
          )
      : [];
    const categoryIds = [...new Set(slots.flatMap((s) => (s.randomCategoryId ? [s.randomCategoryId] : [])))];
    const categories = categoryIds.length ? await tx.select().from(questionCategories).where(inArray(questionCategories.id, categoryIds)) : [];
    const out = [];
    for (const s of slots) {
      const { randomCategoryId, randomIncludeSubcategories, ...slot } = s;
      if (randomCategoryId) {
        const cat = categories.find((c) => c.id === randomCategoryId);
        const available = (await randomCandidates(tx, randomCategoryId, randomIncludeSubcategories)).length;
        out.push({
          ...slot,
          latestVersion: null,
          name: `Random question from "${cat?.name ?? "?"}"${randomIncludeSubcategories ? " and its subcategories" : ""}`,
          type: null,
          deleted: false,
          random: { categoryId: randomCategoryId, categoryName: cat?.name ?? "?", includeSubcategories: randomIncludeSubcategories, available },
        });
        continue;
      }
      const q = qs.find((x) => x.id === s.questionId)!;
      const shown = versions.find((v) => v.questionId === q.id && v.version === (s.pinnedVersion ?? q.latestVersion));
      out.push({
        ...slot,
        latestVersion: q.latestVersion,
        name: shown?.name ?? "(missing)",
        type: (shown?.type ?? "essay") as QuestionType,
        deleted: !!q.deletedAt,
        random: null,
      });
    }
    return out;
  }

  app.get(
    "/:activityId/slots",
    {
      schema: {
        tags: ["Quiz"],
        summary: "Questions in the quiz (editors)",
        params,
        response: { 200: z.object({ slots: z.array(zSlot), locked: z.boolean() }) },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const { quiz } = await loadQuiz(tx, req, req.params.activityId, { capability: "activity:update" });
        return { slots: await slotList(tx, quiz.id), locked: await hasRealAttempts(tx, quiz.id) };
      }),
  );

  app.post(
    "/:activityId/slots",
    {
      schema: {
        tags: ["Quiz"],
        summary: "Add questions from the bank (appended at the end)",
        params,
        body: z.object({ questionIds: z.array(zId).min(1).max(200), maxMark: z.number().min(0).max(1000).optional() }),
        response: { 200: z.array(zSlot) },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const { quiz, activity } = await loadQuiz(tx, req, req.params.activityId, { capability: "activity:update" });
        await assertEditable(tx, quiz);
        const ids = [...new Set(req.body.questionIds)];
        const qs = await tx.select().from(questions).where(inArray(questions.id, ids));
        if (qs.length !== ids.length || qs.some((q) => q.deletedAt)) throw notFound("Question");
        // Questions must come from this course's bank or the shared bank, and be readable by the editor.
        for (const categoryId of new Set(qs.map((q) => q.categoryId))) {
          const cat = await loadCategory(tx, req, categoryId, "read", activity.courseId);
          if (cat.courseId && cat.courseId !== activity.courseId) throw notFound("Question");
        }
        const existing = await slotsOf(tx, quiz.id);
        const latest = await tx.select().from(questionVersions).where(inArray(questionVersions.questionId, ids));
        let position = (existing.at(-1)?.position ?? -1) + 1;
        const rows = ids.map((id) => {
          const q = qs.find((x) => x.id === id)!;
          const v = latest.find((x) => x.questionId === id && x.version === q.latestVersion);
          return {
            organizationId: quiz.organizationId,
            quizId: quiz.id,
            questionId: id,
            position: position++,
            maxMark: req.body.maxMark ?? v?.defaultMark ?? 1,
          };
        });
        await tx.insert(quizSlots).values(rows);
        return slotList(tx, quiz.id);
      }),
  );

  app.post(
    "/:activityId/random-slots",
    {
      schema: {
        tags: ["Quiz"],
        summary: "Add random questions: each attempt draws a different question from the category (appended at the end)",
        params,
        body: z.object({
          categoryId: zId,
          includeSubcategories: z.boolean().default(false),
          count: z.number().int().min(1).max(100).default(1),
          maxMark: z.number().min(0).max(1000).default(1),
        }),
        response: { 200: z.array(zSlot) },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const { quiz, activity } = await loadQuiz(tx, req, req.params.activityId, { capability: "activity:update" });
        await assertEditable(tx, quiz);
        const cat = await loadCategory(tx, req, req.body.categoryId, "read", activity.courseId);
        if (cat.courseId && cat.courseId !== activity.courseId) throw notFound("Category");
        const existing = await slotsOf(tx, quiz.id);
        let position = (existing.at(-1)?.position ?? -1) + 1;
        await tx.insert(quizSlots).values(
          Array.from({ length: req.body.count }, () => ({
            organizationId: quiz.organizationId,
            quizId: quiz.id,
            questionId: null,
            randomCategoryId: cat.id,
            randomIncludeSubcategories: req.body.includeSubcategories,
            position: position++,
            maxMark: req.body.maxMark,
          })),
        );
        return slotList(tx, quiz.id);
      }),
  );

  app.patch(
    "/:activityId/slots/:slotId",
    {
      schema: {
        tags: ["Quiz"],
        summary: "Change a slot's mark or pinned question version (null = always latest)",
        params: slotParams,
        body: z.object({ maxMark: z.number().min(0).max(1000).optional(), pinnedVersion: z.number().int().min(1).nullable().optional() }),
        response: { 200: z.array(zSlot) },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const { quiz } = await loadQuiz(tx, req, req.params.activityId, { capability: "activity:update" });
        await assertEditable(tx, quiz);
        const slot = must(
          (
            await tx
              .select()
              .from(quizSlots)
              .where(and(eq(quizSlots.id, req.params.slotId), eq(quizSlots.quizId, quiz.id)))
              .limit(1)
          )[0],
          "Slot",
        );
        if (req.body.pinnedVersion != null) {
          if (!slot.questionId) throw badRequest("Random questions have no version to pin");
          const [v] = await tx
            .select({ id: questionVersions.id })
            .from(questionVersions)
            .where(and(eq(questionVersions.questionId, slot.questionId), eq(questionVersions.version, req.body.pinnedVersion)))
            .limit(1);
          if (!v) throw badRequest("That version does not exist");
        }
        if (Object.keys(req.body).length) await tx.update(quizSlots).set(req.body).where(eq(quizSlots.id, slot.id));
        return slotList(tx, quiz.id);
      }),
  );

  app.put(
    "/:activityId/slots/order",
    {
      schema: {
        tags: ["Quiz"],
        summary: "Reorder questions (affects new attempts only)",
        params,
        body: z.object({ slotIds: z.array(zId) }),
        response: { 200: z.array(zSlot) },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const { quiz } = await loadQuiz(tx, req, req.params.activityId, { capability: "activity:update" });
        const slots = await slotsOf(tx, quiz.id);
        const given = new Set(req.body.slotIds);
        if (given.size !== slots.length || slots.some((s) => !given.has(s.id))) throw badRequest("slotIds must list every slot exactly once");
        for (const [position, id] of req.body.slotIds.entries()) {
          await tx
            .update(quizSlots)
            .set({ position })
            .where(and(eq(quizSlots.id, id), eq(quizSlots.quizId, quiz.id)));
        }
        return slotList(tx, quiz.id);
      }),
  );

  app.delete(
    "/:activityId/slots/:slotId",
    { schema: { tags: ["Quiz"], summary: "Remove a question from the quiz", params: slotParams, response: { 200: z.array(zSlot) } } },
    (req) =>
      req.tenant(async (tx) => {
        const { quiz } = await loadQuiz(tx, req, req.params.activityId, { capability: "activity:update" });
        await assertEditable(tx, quiz);
        const [deleted] = await tx
          .delete(quizSlots)
          .where(and(eq(quizSlots.id, req.params.slotId), eq(quizSlots.quizId, quiz.id)))
          .returning();
        must(deleted, "Slot");
        const rest = await slotsOf(tx, quiz.id);
        for (const [position, s] of rest.entries()) if (s.position !== position) await tx.update(quizSlots).set({ position }).where(eq(quizSlots.id, s.id));
        return slotList(tx, quiz.id);
      }),
  );

  // ─── Attempts ───────────────────────────────────────────────────────────

  app.post(
    "/:activityId/attempts",
    {
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        tags: ["Quiz"],
        summary: "Start an attempt (or continue the one in progress). Teachers without quiz:attempt get a preview.",
        params,
        body: z.object({}).optional(),
        response: { 200: z.object({ attemptId: zId, resumed: z.boolean(), preview: z.boolean() }) },
      },
    },
    async (req) => {
      requireUser(req);
      const { result, events } = await req.tenant(async (tx) => {
        const { quiz, activity } = await loadQuiz(tx, req, req.params.activityId);
        const r = await startAttempt(tx, req, quiz, activity);
        return { result: { attemptId: r.attempt.id, resumed: r.resumed, preview: isPreview(r.attempt) }, events: r.events };
      });
      await emitAll(events);
      return result;
    },
  );

  app.get(
    "/:activityId/attempts/:attemptId",
    {
      schema: {
        tags: ["Quiz"],
        summary: "An attempt with its questions. Learners never get answers while in progress; review follows the quiz's review options.",
        params: attemptParams,
        response: { 200: zAttemptDetail },
      },
    },
    async (req) => {
      requireUser(req);
      const { out, events } = await req.tenant(async (tx) => {
        const { quiz, activity } = await loadQuiz(tx, req, req.params.activityId);
        const loaded = await loadAttempt(tx, req, quiz, activity, req.params.attemptId);
        const { attempt, events } = await closeIfOverdue(tx, quiz, activity, loaded.attempt);
        const finished = attempt.status === "finished";
        const reviewer = loaded.reviewer;
        const show = visibilityFor({ finished, reviewer, reviewOptions: quiz.reviewOptions });
        const rows = await answersOf(tx, attempt);
        const [user] = await tx
          .select({ id: users.id, firstName: users.firstName, lastName: users.lastName })
          .from(users)
          .where(eq(users.id, attempt.userId))
          .limit(1);
        const marksVisible = finished && show.marks;
        return {
          events,
          out: {
            attempt: {
              ...attempt,
              preview: isPreview(attempt),
              sumMarks: marksVisible ? attempt.sumMarks : undefined,
              grade: marksVisible ? attempt.grade : undefined,
              totalMarks: round5(rows.reduce((s, r) => s + r.answer.maxMark, 0)),
              gradeMax: quiz.gradeMax,
              serverNow: new Date(),
            },
            user: user!,
            quiz: { activityId: activity.id, name: activity.name, courseId: activity.courseId },
            isOwner: loaded.owner,
            isReviewer: reviewer,
            canGrade: await hasCapability(tx, req, "quiz:grade", activity.contextId),
            show,
            questions: rows.map((r, i) => {
              const q = presentQuestion(r, i, show, { reviewer, finished });
              return { ...q, response: q.response as z.infer<typeof zResponse> };
            }),
          },
        };
      });
      await emitAll(events);
      return out;
    },
  );

  app.put(
    "/:activityId/attempts/:attemptId/responses",
    {
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
      schema: {
        tags: ["Quiz"],
        summary: "Save responses (autosave). Rejected once the attempt is finished or past its deadline.",
        params: attemptParams,
        body: z.object({ responses: z.array(z.object({ slotId: zId, response: z.unknown() })).max(500) }),
        response: { 200: z.object({ savedAt: zDate, dueAt: zNullableDate }) },
      },
    },
    async (req) => {
      const me = requireUser(req);
      const { out, events, error } = await req.tenant(async (tx) => {
        const { quiz, activity } = await loadQuiz(tx, req, req.params.activityId);
        const { attempt } = await loadAttempt(tx, req, quiz, activity, req.params.attemptId);
        if (attempt.userId !== me.id) throw notFound("Attempt");
        if (attempt.status !== "in_progress") throw conflict("This attempt is already finished");
        if (isOverdue(attempt.dueAt, new Date())) {
          // Time is up: grade what was saved before the deadline and refuse this save.
          const closed = await finishAttempt(tx, quiz, activity, attempt);
          return { out: null, events: closed.events, error: "Time is up: your attempt was submitted with the answers saved before the deadline" };
        }
        const rows = await answersOf(tx, attempt);
        const bySlot = new Map(rows.map((r) => [r.answer.slotId, r]));
        for (const { slotId, response } of req.body.responses) {
          const row = bySlot.get(slotId);
          if (!row) throw badRequest("Unknown question");
          const parsed = parseResponse(row.version.type as QuestionType, response);
          if (response !== null && response !== undefined && parsed === null) throw badRequest(`Invalid response for question ${row.answer.slotId}`);
          await tx.update(attemptAnswers).set({ response: parsed }).where(eq(attemptAnswers.id, row.answer.id));
        }
        return { out: { savedAt: new Date(), dueAt: attempt.dueAt }, events: [] as PendingEvent[], error: null };
      });
      await emitAll(events);
      if (error) throw conflict(error);
      return out!;
    },
  );

  app.post(
    "/:activityId/attempts/:attemptId/finish",
    {
      schema: {
        tags: ["Quiz"],
        summary: "Submit an attempt: auto-grades and updates the gradebook",
        params: attemptParams,
        body: z
          .object({
            responses: z
              .array(z.object({ slotId: zId, response: z.unknown() }))
              .max(500)
              .optional(),
          })
          .optional(),
        response: { 200: zAttemptSummary },
      },
    },
    async (req) => {
      const me = requireUser(req);
      const { out, events } = await req.tenant(async (tx) => {
        const { quiz, activity } = await loadQuiz(tx, req, req.params.activityId);
        const { attempt } = await loadAttempt(tx, req, quiz, activity, req.params.attemptId);
        if (attempt.userId !== me.id) throw notFound("Attempt");
        if (attempt.status !== "in_progress") throw conflict("This attempt is already finished");
        // Last-second responses are accepted only within the deadline (+ grace).
        if (req.body?.responses?.length && !isOverdue(attempt.dueAt, new Date())) {
          const rows = await answersOf(tx, attempt);
          const bySlot = new Map(rows.map((r) => [r.answer.slotId, r]));
          for (const { slotId, response } of req.body.responses) {
            const row = bySlot.get(slotId);
            if (!row) throw badRequest("Unknown question");
            const parsed = parseResponse(row.version.type as QuestionType, response);
            if (response !== null && response !== undefined && parsed === null) throw badRequest("Invalid response");
            await tx.update(attemptAnswers).set({ response: parsed }).where(eq(attemptAnswers.id, row.answer.id));
          }
        }
        const r = await finishAttempt(tx, quiz, activity, attempt);
        const showMarks = quiz.reviewOptions.marks;
        return {
          out: {
            ...r.attempt,
            preview: isPreview(r.attempt),
            sumMarks: showMarks ? r.attempt.sumMarks : undefined,
            grade: showMarks ? r.attempt.grade : undefined,
          },
          events: r.events,
        };
      });
      await emitAll(events);
      return out;
    },
  );

  // ─── Teacher: results & manual grading ──────────────────────────────────

  app.get(
    "/:activityId/results",
    {
      schema: {
        tags: ["Quiz"],
        summary: "All attempts and per-question statistics (facility index)",
        params,
        response: {
          200: z.object({
            gradeMax: z.number(),
            totalMarks: z.number(),
            attempts: z.array(zAttemptSummary.extend({ user: z.object({ id: zId, firstName: z.string(), lastName: z.string(), email: z.string() }) })),
            questions: z.array(
              z.object({
                slotId: zId,
                number: z.number().int(),
                name: z.string(),
                /** null for random slots (the question differs per attempt). */
                type: z.enum(QUESTION_TYPES).nullable(),
                maxMark: z.number(),
                responses: z.number().int(),
                averageMark: z.number().nullable(),
                facility: z.number().nullable(),
                needsGrading: z.number().int(),
              }),
            ),
          }),
        },
      },
    },
    async (req) => {
      requireUser(req);
      const { out, events } = await req.tenant(async (tx) => {
        const { quiz, activity } = await loadQuiz(tx, req, req.params.activityId, { capability: "quiz:view_reports" });
        // Close overdue attempts so the report reflects reality.
        const open = await tx
          .select()
          .from(quizAttempts)
          .where(and(eq(quizAttempts.quizId, quiz.id), eq(quizAttempts.status, "in_progress")));
        const events: PendingEvent[] = [];
        for (const a of open) events.push(...(await closeIfOverdue(tx, quiz, activity, a)).events);

        const attempts = await tx
          .select({ a: quizAttempts, u: { id: users.id, firstName: users.firstName, lastName: users.lastName, email: users.email } })
          .from(quizAttempts)
          .innerJoin(users, eq(users.id, quizAttempts.userId))
          .where(and(eq(quizAttempts.quizId, quiz.id), gt(quizAttempts.attempt, PREVIEW_ATTEMPT)))
          .orderBy(asc(users.lastName), asc(users.firstName), asc(quizAttempts.attempt));
        const finishedIds = attempts.filter((x) => x.a.status === "finished").map((x) => x.a.id);
        const answers = finishedIds.length
          ? await tx
              .select({
                slotId: attemptAnswers.slotId,
                fraction: attemptAnswers.fraction,
                mark: attemptAnswers.mark,
                needsGrading: attemptAnswers.needsGrading,
              })
              .from(attemptAnswers)
              .where(inArray(attemptAnswers.attemptId, finishedIds))
          : [];
        const slots = await slotList(tx, quiz.id);
        return {
          events,
          out: {
            gradeMax: quiz.gradeMax,
            totalMarks: round5(slots.reduce((s, x) => s + x.maxMark, 0)),
            attempts: attempts.map(({ a, u }) => ({ ...a, preview: false, user: u })),
            questions: slots.map((s, i) => {
              const mine = answers.filter((a) => a.slotId === s.id);
              const graded = mine.filter((a) => !a.needsGrading);
              return {
                slotId: s.id,
                number: i + 1,
                name: s.name,
                type: s.type,
                maxMark: s.maxMark,
                responses: mine.length,
                averageMark: graded.length ? round5(graded.reduce((t, a) => t + (a.mark ?? 0), 0) / graded.length) : null,
                facility: facilityIndex(graded.map((a) => a.fraction)),
                needsGrading: mine.length - graded.length,
              };
            }),
          },
        };
      });
      await emitAll(events);
      return out;
    },
  );

  app.post(
    "/:activityId/attempts/:attemptId/slots/:slotId/grade",
    {
      schema: {
        tags: ["Quiz"],
        summary: "Manually grade (or override) one answer; regrades the attempt and the quiz grade",
        params: attemptParams.extend({ slotId: zId }),
        body: z.object({ mark: z.number().min(0), comment: z.string().max(20_000).nullable().optional() }),
        response: { 200: zOk },
      },
    },
    async (req) => {
      const me = requireUser(req);
      const events = await req.tenant(async (tx) => {
        const { quiz, activity } = await loadQuiz(tx, req, req.params.activityId, { capability: "quiz:grade" });
        await requireCapability(tx, req, "quiz:view_reports", activity.contextId);
        const { attempt } = await loadAttempt(tx, req, quiz, activity, req.params.attemptId);
        if (attempt.status !== "finished") throw conflict("Only finished attempts can be graded");
        const answer = must(
          (
            await tx
              .select()
              .from(attemptAnswers)
              .where(and(eq(attemptAnswers.attemptId, attempt.id), eq(attemptAnswers.slotId, req.params.slotId)))
              .limit(1)
          )[0],
          "Answer",
        );
        if (req.body.mark > answer.maxMark) throw badRequest(`The mark cannot exceed ${answer.maxMark}`);
        await tx
          .update(attemptAnswers)
          .set({
            mark: round5(req.body.mark),
            fraction: answer.maxMark > 0 ? req.body.mark / answer.maxMark : 0,
            needsGrading: false,
            comment: req.body.comment ? cleanHtml(req.body.comment) : null,
            gradedBy: me.id,
          })
          .where(eq(attemptAnswers.id, answer.id));
        const updated = await retotalAttempt(tx, quiz, attempt);
        await audit(
          tx,
          req,
          "quiz.answer_graded",
          { type: "quiz_attempt", id: attempt.id },
          { slotId: answer.slotId, mark: req.body.mark, oldMark: answer.mark },
        );

        const events: PendingEvent[] = [];
        if (!isPreview(updated)) {
          const grade = await syncQuizGrade(tx, quiz, activity, updated.userId, me.id);
          if (grade) events.push({ name: "grade.updated", payload: grade });
          if (!updated.needsGrading && updated.userId !== me.id) {
            await notify(tx, {
              organizationId: req.org.id,
              userIds: [updated.userId],
              type: "quiz_graded",
              title: `Your attempt at "${activity.name}" was graded`,
              link: `/activities/${activity.id}/quiz/attempt/${updated.id}`,
            });
          }
        }
        return events;
      });
      await emitAll(events);
      return ok;
    },
  );

  app.delete(
    "/:activityId/attempts/:attemptId",
    {
      schema: { tags: ["Quiz"], summary: "Delete an attempt (graders) and recompute the learner's grade", params: attemptParams, response: { 200: zOk } },
    },
    async (req) => {
      const me = requireUser(req);
      const events = await req.tenant(async (tx) => {
        const { quiz, activity } = await loadQuiz(tx, req, req.params.activityId, { capability: "quiz:grade" });
        const { attempt } = await loadAttempt(tx, req, quiz, activity, req.params.attemptId);
        await tx.delete(quizAttempts).where(eq(quizAttempts.id, attempt.id));
        await audit(
          tx,
          req,
          "quiz.attempt_deleted",
          { type: "quiz_attempt", id: attempt.id },
          { userId: attempt.userId, attempt: attempt.attempt, grade: attempt.grade },
        );
        const events: PendingEvent[] = [];
        if (!isPreview(attempt)) {
          const grade = await syncQuizGrade(tx, quiz, activity, attempt.userId, me.id, true);
          if (grade) events.push({ name: "grade.updated", payload: grade });
        }
        return events;
      });
      await emitAll(events);
      return ok;
    },
  );
};
