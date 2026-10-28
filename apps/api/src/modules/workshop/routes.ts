import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { files, workshopAssessments, workshopSubmissions, workshops, type DB } from "@lms/db";
import { z } from "zod";
import { audit } from "../../core/audit";
import { AppError, badRequest, conflict, forbidden, notFound } from "../../core/errors";
import { emit, type EventMap } from "../../core/events";
import { assertOwnFiles, softDeleteFile } from "../../core/files";
import { notify } from "../../core/notify";
import { requireCapability } from "../../core/rbac";
import { cleanHtml } from "../../core/sanitize";
import { zDate, zId, zNullableDate } from "../../core/schemas";
import { learnerIds, userSummaries } from "../forum/people";
import { allocateReviewers, assessmentGrade, computeWorkshopGrades } from "./logic";
import {
  fileSummaries,
  gradeBreakdown,
  loadWorkshop,
  PHASES,
  pushWorkshopGrade,
  reviewerGrade,
  type Phase,
  type SubmissionRow,
  type WorkshopCtx,
} from "./service";

const tags = ["Workshop"];
const params = z.object({ activityId: zId });
const zPerson = z.object({ id: zId, firstName: z.string(), lastName: z.string() });
const zFileSummary = z.object({ id: zId, filename: z.string(), mimeType: z.string(), size: z.number() });
const zCriterion = z.object({ id: z.string(), description: z.string(), maxScore: z.number(), weight: z.number() });

const zSubmission = z.object({
  id: zId,
  title: z.string(),
  content: z.string().nullable(),
  files: z.array(zFileSummary),
  grade: z.number().nullable(),
  gradeOverride: z.number().nullable(),
  createdAt: zDate,
  updatedAt: zNullableDate,
});

const zReceived = z.object({ id: zId, grade: z.number().nullable(), feedback: z.string().nullable(), scores: z.record(z.string(), z.number()).nullable() });

const zOverview = z.object({
  phase: z.enum(PHASES),
  instructions: z.string().nullable(),
  assessmentInstructions: z.string().nullable(),
  submissionEndAt: zNullableDate,
  assessmentEndAt: zNullableDate,
  submissionGradeMax: z.number(),
  assessmentGradeMax: z.number(),
  reviewsPerSubmission: z.number().int(),
  allowSelfAssessment: z.boolean(),
  criteria: z.array(zCriterion),
  canManage: z.boolean(),
  canSubmit: z.boolean(),
  canAssess: z.boolean(),
  mySubmission: zSubmission.nullable(),
  myAssessments: z.array(
    z.object({ id: zId, submissionId: zId, submissionTitle: z.string(), isOwn: z.boolean(), submittedAt: zNullableDate, grade: z.number().nullable() }),
  ),
  /** Available in the evaluation/closed phases once grades are calculated. */
  myResults: z
    .object({
      submissionGrade: z.number().nullable(),
      gradingGrade: z.number().nullable(),
      total: z.number().nullable(),
      received: z.array(zReceived),
    })
    .nullable(),
  stats: z.object({ participants: z.number().int(), submissions: z.number().int(), allocations: z.number().int(), assessed: z.number().int() }).nullable(),
});

const PHASE_LABEL: Record<Phase, string> = {
  setup: "Setup",
  submission: "Submission",
  assessment: "Assessment",
  evaluation: "Grading evaluation",
  closed: "Closed",
};

async function toSubmission(tx: DB, s: SubmissionRow) {
  return {
    id: s.id,
    title: s.title,
    content: s.content,
    files: await fileSummaries(tx, s.fileIds),
    grade: s.grade,
    gradeOverride: s.gradeOverride,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

function requireManage(ctx: WorkshopCtx) {
  if (!ctx.canManage) throw forbidden("Missing capability workshop:manage");
}

function assertPhase(ctx: WorkshopCtx, ...phases: Phase[]) {
  if (!phases.includes(ctx.workshop.phase)) {
    throw new AppError(409, "WRONG_PHASE", `Not possible in the ${PHASE_LABEL[ctx.workshop.phase].toLowerCase()} phase`);
  }
}

async function submissionsOf(tx: DB, workshopId: string) {
  return tx.select().from(workshopSubmissions).where(eq(workshopSubmissions.workshopId, workshopId)).orderBy(asc(workshopSubmissions.createdAt));
}

async function loadAssessment(tx: DB, ctx: WorkshopCtx, assessmentId: string) {
  const [row] = await tx
    .select({ a: workshopAssessments, s: workshopSubmissions })
    .from(workshopAssessments)
    .innerJoin(workshopSubmissions, eq(workshopSubmissions.id, workshopAssessments.submissionId))
    .where(and(eq(workshopAssessments.id, assessmentId), eq(workshopSubmissions.workshopId, ctx.workshop.id)))
    .limit(1);
  // Reviewers see their own allocations; managers see all. Others: 404.
  if (!row || (row.a.reviewerId !== ctx.me.id && !ctx.canManage)) throw notFound("Assessment");
  return row;
}

export const routes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/:activityId",
    { schema: { tags, summary: "Workshop overview for the current user (phase, my submission, my assessments, results)", params, response: { 200: zOverview } } },
    (req) =>
      req.tenant(async (tx) => {
        const ctx = await loadWorkshop(tx, req, req.params.activityId);
        const w = ctx.workshop;
        const [mine] = await tx
          .select()
          .from(workshopSubmissions)
          .where(and(eq(workshopSubmissions.workshopId, w.id), eq(workshopSubmissions.userId, ctx.me.id)))
          .limit(1);
        const allocated = await tx
          .select({ a: workshopAssessments, title: workshopSubmissions.title, authorId: workshopSubmissions.userId })
          .from(workshopAssessments)
          .innerJoin(workshopSubmissions, eq(workshopSubmissions.id, workshopAssessments.submissionId))
          .where(and(eq(workshopSubmissions.workshopId, w.id), eq(workshopAssessments.reviewerId, ctx.me.id)))
          .orderBy(asc(workshopAssessments.createdAt));
        // Reviewers only see their allocations once assessment starts.
        const showAllocations = ["assessment", "evaluation", "closed"].includes(w.phase);

        let myResults: z.infer<typeof zOverview>["myResults"] = null;
        if ((w.phase === "evaluation" || w.phase === "closed") && (mine || allocated.length)) {
          const received = mine
            ? await tx
                .select()
                .from(workshopAssessments)
                .where(and(eq(workshopAssessments.submissionId, mine.id)))
                .orderBy(asc(workshopAssessments.createdAt))
            : [];
          const grading = reviewerGrade(allocated.map((r) => r.a.gradingGrade), w.assessmentGradeMax);
          const sub = mine ? (mine.gradeOverride ?? mine.grade) : null;
          myResults = {
            submissionGrade: sub,
            gradingGrade: grading,
            total: sub === null && grading === null ? null : (sub ?? 0) + (grading ?? 0),
            received: received.filter((a) => a.submittedAt).map((a) => ({ id: a.id, grade: a.grade, feedback: a.feedback, scores: a.scores })),
          };
        }

        let stats: z.infer<typeof zOverview>["stats"] = null;
        if (ctx.canManage) {
          const subs = await submissionsOf(tx, w.id);
          const all = subs.length
            ? await tx.select({ submittedAt: workshopAssessments.submittedAt }).from(workshopAssessments).where(inArray(workshopAssessments.submissionId, subs.map((s) => s.id)))
            : [];
          stats = {
            participants: (await learnerIds(tx, ctx.course)).length,
            submissions: subs.length,
            allocations: all.length,
            assessed: all.filter((a) => a.submittedAt).length,
          };
        }

        return {
          phase: w.phase,
          instructions: w.instructions,
          assessmentInstructions: w.assessmentInstructions,
          submissionEndAt: w.submissionEndAt,
          assessmentEndAt: w.assessmentEndAt,
          submissionGradeMax: w.submissionGradeMax,
          assessmentGradeMax: w.assessmentGradeMax,
          reviewsPerSubmission: w.reviewsPerSubmission,
          allowSelfAssessment: w.allowSelfAssessment,
          criteria: w.criteria,
          canManage: ctx.canManage,
          canSubmit: ctx.canSubmit,
          canAssess: ctx.canAssess,
          mySubmission: mine ? await toSubmission(tx, mine) : null,
          myAssessments: showAllocations || ctx.canManage
            ? allocated.map((r) => ({
                id: r.a.id,
                submissionId: r.a.submissionId,
                submissionTitle: r.title,
                isOwn: r.authorId === ctx.me.id,
                submittedAt: r.a.submittedAt,
                grade: r.a.grade,
              }))
            : [],
          myResults,
          stats,
        };
      }),
  );

  app.put(
    "/:activityId/phase",
    {
      schema: { tags, summary: "Switch the workshop phase (workshop:manage)", params, body: z.object({ phase: z.enum(PHASES) }), response: { 200: z.object({ phase: z.enum(PHASES) }) } },
    },
    async (req) => {
      const out = await req.tenant(async (tx) => {
        const ctx = await loadWorkshop(tx, req, req.params.activityId);
        requireManage(ctx);
        const from = ctx.workshop.phase;
        const to = req.body.phase;
        if (from === to) return { ctx, changed: false, phase: to };
        await tx.update(workshops).set({ phase: to }).where(eq(workshops.id, ctx.workshop.id));
        await audit(tx, req, "workshop.phase_changed", { type: "activity", id: ctx.activity.id }, { from, to });
        await notify(tx, {
          organizationId: req.org.id,
          userIds: (await learnerIds(tx, ctx.course)).filter((id) => id !== ctx.me.id),
          type: "workshop_phase",
          title: `${ctx.activity.name}: ${PHASE_LABEL[to]} phase`,
          body:
            to === "submission"
              ? "You can now submit your work."
              : to === "assessment"
                ? "You can now assess the submissions allocated to you."
                : to === "closed"
                  ? "The workshop is closed. Your results are available."
                  : undefined,
          link: `/activities/${ctx.activity.id}`,
        });
        return { ctx, changed: true, phase: to };
      });
      if (out.changed) {
        await emit("workshop.phase_changed", {
          organizationId: req.org.id,
          activityId: out.ctx.activity.id,
          courseId: out.ctx.course.id,
          userId: out.ctx.me.id,
          phase: out.phase,
        });
      }
      return { phase: out.phase };
    },
  );

  // ─── Submission ─────────────────────────────────────────────────────────

  app.put(
    "/:activityId/submission",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags,
        summary: "Create or update my submission (submission phase)",
        params,
        body: z.object({
          title: z.string().trim().min(1).max(255),
          content: z.string().max(200_000).nullable().optional(),
          fileIds: z.array(zId).max(20).default([]),
        }),
        response: { 200: zSubmission },
      },
    },
    async (req) => {
      const out = await req.tenant(async (tx) => {
        const ctx = await loadWorkshop(tx, req, req.params.activityId);
        await requireCapability(tx, req, "workshop:submit", ctx.activity.contextId);
        assertPhase(ctx, "submission");
        if (ctx.workshop.submissionEndAt && ctx.workshop.submissionEndAt < new Date()) throw new AppError(409, "DEADLINE_PASSED", "The submission deadline has passed");

        const fileIds = [...new Set(req.body.fileIds)];
        const [existing] = await tx
          .select()
          .from(workshopSubmissions)
          .where(and(eq(workshopSubmissions.workshopId, ctx.workshop.id), eq(workshopSubmissions.userId, ctx.me.id)))
          .limit(1);
        const newIds = fileIds.filter((id) => !existing?.fileIds.includes(id));
        await assertOwnFiles(tx, req, newIds);
        const content = req.body.content ? cleanHtml(req.body.content) : null;
        if (!content && !fileIds.length) throw badRequest("Add some text or at least one file");

        const values = { title: req.body.title, content, fileIds, updatedAt: new Date() };
        const [row] = existing
          ? await tx.update(workshopSubmissions).set(values).where(eq(workshopSubmissions.id, existing.id)).returning()
          : await tx
              .insert(workshopSubmissions)
              .values({ ...values, organizationId: req.org.id, workshopId: ctx.workshop.id, userId: ctx.me.id })
              .returning();
        if (fileIds.length) {
          await tx
            .update(files)
            .set({ component: "workshop", area: "submission", itemId: row!.id, contextId: ctx.activity.contextId })
            .where(and(inArray(files.id, fileIds), eq(files.ownerId, ctx.me.id)));
        }
        for (const removed of existing?.fileIds.filter((id) => !fileIds.includes(id)) ?? []) await softDeleteFile(tx, removed);
        return { ctx, row: row!, created: !existing, submission: await toSubmission(tx, row!) };
      });
      if (out.created) {
        await emit("activity.submitted", { organizationId: req.org.id, activityId: out.ctx.activity.id, courseId: out.ctx.course.id, userId: out.ctx.me.id });
      }
      return out.submission;
    },
  );

  app.get(
    "/:activityId/submissions/:submissionId",
    {
      schema: {
        tags,
        summary: "A submission with its assessments (workshop:manage)",
        params: params.extend({ submissionId: zId }),
        response: {
          200: zSubmission.extend({
            author: zPerson,
            assessments: z.array(zReceived.extend({ reviewer: zPerson, submittedAt: zNullableDate, gradingGrade: z.number().nullable() })),
          }),
        },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const ctx = await loadWorkshop(tx, req, req.params.activityId);
        requireManage(ctx);
        const [s] = await tx
          .select()
          .from(workshopSubmissions)
          .where(and(eq(workshopSubmissions.id, req.params.submissionId), eq(workshopSubmissions.workshopId, ctx.workshop.id)))
          .limit(1);
        if (!s) throw notFound("Submission");
        const assessments = await tx.select().from(workshopAssessments).where(eq(workshopAssessments.submissionId, s.id)).orderBy(asc(workshopAssessments.createdAt));
        const people = await userSummaries(tx, [s.userId, ...assessments.map((a) => a.reviewerId)]);
        return {
          ...(await toSubmission(tx, s)),
          author: people.get(s.userId)!,
          assessments: assessments.map((a) => ({
            id: a.id,
            grade: a.grade,
            feedback: a.feedback,
            scores: a.scores,
            reviewer: people.get(a.reviewerId)!,
            submittedAt: a.submittedAt,
            gradingGrade: a.gradingGrade,
          })),
        };
      }),
  );

  app.put(
    "/:activityId/submissions/:submissionId/override",
    {
      schema: {
        tags,
        summary: "Override (or clear) a submission grade (workshop:manage)",
        params: params.extend({ submissionId: zId }),
        body: z.object({ gradeOverride: z.number().min(0).nullable() }),
        response: { 200: z.object({ gradeOverride: z.number().nullable() }) },
      },
    },
    async (req) => {
      const out = await req.tenant(async (tx) => {
        const ctx = await loadWorkshop(tx, req, req.params.activityId);
        requireManage(ctx);
        const { gradeOverride } = req.body;
        if (gradeOverride !== null && gradeOverride > ctx.workshop.submissionGradeMax) {
          throw badRequest(`The grade cannot exceed ${ctx.workshop.submissionGradeMax}`);
        }
        const [s] = await tx
          .update(workshopSubmissions)
          .set({ gradeOverride })
          .where(and(eq(workshopSubmissions.id, req.params.submissionId), eq(workshopSubmissions.workshopId, ctx.workshop.id)))
          .returning();
        if (!s) throw notFound("Submission");
        await audit(tx, req, "workshop.grade_overridden", { type: "workshop_submission", id: s.id }, { userId: s.userId, gradeOverride });
        let payload: EventMap["grade.updated"] | null = null;
        if (ctx.workshop.phase === "evaluation" || ctx.workshop.phase === "closed") {
          const row = (await gradeBreakdown(tx, ctx.workshop)).find((r) => r.userId === s.userId);
          payload = await pushWorkshopGrade(tx, { activity: ctx.activity, userId: s.userId, total: row?.total ?? null, gradedBy: ctx.me.id });
        }
        return { gradeOverride: s.gradeOverride, payload };
      });
      if (out.payload) await emit("grade.updated", out.payload);
      return { gradeOverride: out.gradeOverride };
    },
  );

  // ─── Allocation ─────────────────────────────────────────────────────────

  app.get(
    "/:activityId/allocations",
    {
      schema: {
        tags,
        summary: "Submissions with their reviewers, and the participants (workshop:manage)",
        params,
        response: {
          200: z.object({
            submissions: z.array(
              z.object({
                id: zId,
                title: z.string(),
                author: zPerson,
                reviewers: z.array(z.object({ assessmentId: zId, reviewer: zPerson, submittedAt: zNullableDate, grade: z.number().nullable() })),
              }),
            ),
            participants: z.array(zPerson.extend({ hasSubmission: z.boolean(), reviewing: z.number().int() })),
          }),
        },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const ctx = await loadWorkshop(tx, req, req.params.activityId);
        requireManage(ctx);
        const subs = await submissionsOf(tx, ctx.workshop.id);
        const assessments = subs.length
          ? await tx.select().from(workshopAssessments).where(inArray(workshopAssessments.submissionId, subs.map((s) => s.id))).orderBy(asc(workshopAssessments.createdAt))
          : [];
        const learners = await learnerIds(tx, ctx.course);
        const people = await userSummaries(tx, [...learners, ...subs.map((s) => s.userId), ...assessments.map((a) => a.reviewerId)]);
        const unknown = (id: string) => people.get(id) ?? { id, firstName: "Unknown", lastName: "user" };
        return {
          submissions: subs.map((s) => ({
            id: s.id,
            title: s.title,
            author: unknown(s.userId),
            reviewers: assessments
              .filter((a) => a.submissionId === s.id)
              .map((a) => ({ assessmentId: a.id, reviewer: unknown(a.reviewerId), submittedAt: a.submittedAt, grade: a.grade })),
          })),
          participants: [...new Set([...learners, ...subs.map((s) => s.userId)])]
            .map((id) => ({
              ...unknown(id),
              hasSubmission: subs.some((s) => s.userId === id),
              reviewing: assessments.filter((a) => a.reviewerId === id).length,
            }))
            .sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName)),
        };
      }),
  );

  app.post(
    "/:activityId/allocations/random",
    {
      schema: {
        tags,
        summary: "Randomly allocate reviewers (balanced; no self-review unless allowed)",
        params,
        body: z.object({
          /** Remove allocations that haven't been assessed yet before allocating. */
          replace: z.boolean().default(false),
          /** Let learners without a submission review too. */
          includeNonSubmitters: z.boolean().default(false),
        }),
        response: { 200: z.object({ created: z.number().int(), removed: z.number().int() }) },
      },
    },
    async (req) =>
      req.tenant(async (tx) => {
        const ctx = await loadWorkshop(tx, req, req.params.activityId);
        requireManage(ctx);
        assertPhase(ctx, "setup", "submission", "assessment");
        const subs = await submissionsOf(tx, ctx.workshop.id);
        if (!subs.length) throw badRequest("There are no submissions to allocate");
        const subIds = subs.map((s) => s.id);
        let removed = 0;
        if (req.body.replace) {
          const gone = await tx
            .delete(workshopAssessments)
            .where(and(inArray(workshopAssessments.submissionId, subIds), isNull(workshopAssessments.submittedAt)))
            .returning({ id: workshopAssessments.id });
          removed = gone.length;
        }
        const existing = await tx
          .select({ submissionId: workshopAssessments.submissionId, reviewerId: workshopAssessments.reviewerId })
          .from(workshopAssessments)
          .where(inArray(workshopAssessments.submissionId, subIds));
        const learners = new Set(await learnerIds(tx, ctx.course));
        const authors = subs.map((s) => s.userId).filter((id) => learners.has(id));
        const reviewers = req.body.includeNonSubmitters ? [...learners] : authors;
        const allocations = allocateReviewers({
          submissions: subs.map((s) => ({ id: s.id, authorId: s.userId })),
          reviewers,
          perSubmission: ctx.workshop.reviewsPerSubmission,
          allowSelf: ctx.workshop.allowSelfAssessment,
          existing,
        });
        if (allocations.length) {
          await tx
            .insert(workshopAssessments)
            .values(allocations.map((a) => ({ organizationId: req.org.id, submissionId: a.submissionId, reviewerId: a.reviewerId })))
            .onConflictDoNothing();
        }
        await audit(tx, req, "workshop.allocated", { type: "activity", id: ctx.activity.id }, { created: allocations.length, removed });
        return { created: allocations.length, removed };
      }),
  );

  app.post(
    "/:activityId/allocations",
    {
      schema: {
        tags,
        summary: "Manually allocate a reviewer to a submission",
        params,
        body: z.object({ submissionId: zId, reviewerId: zId }),
        response: { 201: z.object({ assessmentId: zId }) },
      },
    },
    async (req, reply) => {
      const out = await req.tenant(async (tx) => {
        const ctx = await loadWorkshop(tx, req, req.params.activityId);
        requireManage(ctx);
        assertPhase(ctx, "setup", "submission", "assessment");
        const [s] = await tx
          .select()
          .from(workshopSubmissions)
          .where(and(eq(workshopSubmissions.id, req.body.submissionId), eq(workshopSubmissions.workshopId, ctx.workshop.id)))
          .limit(1);
        if (!s) throw notFound("Submission");
        if (!(await learnerIds(tx, ctx.course)).includes(req.body.reviewerId)) throw badRequest("The reviewer must be a learner in this course");
        if (s.userId === req.body.reviewerId && !ctx.workshop.allowSelfAssessment) throw badRequest("Self-assessment is not allowed in this workshop");
        const [a] = await tx
          .insert(workshopAssessments)
          .values({ organizationId: req.org.id, submissionId: s.id, reviewerId: req.body.reviewerId })
          .onConflictDoNothing()
          .returning();
        if (!a) throw conflict("This reviewer is already allocated to the submission");
        await audit(tx, req, "workshop.allocation_added", { type: "workshop_assessment", id: a.id }, { submissionId: s.id, reviewerId: a.reviewerId });
        return { assessmentId: a.id };
      });
      return reply.status(201).send(out);
    },
  );

  app.delete(
    "/:activityId/allocations/:assessmentId",
    { schema: { tags, summary: "Remove an allocation (and its assessment)", params: params.extend({ assessmentId: zId }), response: { 200: z.object({ ok: z.literal(true) }) } } },
    async (req) => {
      await req.tenant(async (tx) => {
        const ctx = await loadWorkshop(tx, req, req.params.activityId);
        requireManage(ctx);
        const { a } = await loadAssessment(tx, ctx, req.params.assessmentId);
        await tx.delete(workshopAssessments).where(eq(workshopAssessments.id, a.id));
        await audit(tx, req, "workshop.allocation_removed", { type: "workshop_assessment", id: a.id }, { submissionId: a.submissionId, reviewerId: a.reviewerId, wasSubmitted: !!a.submittedAt });
      });
      return { ok: true as const };
    },
  );

  // ─── Assessment ─────────────────────────────────────────────────────────

  app.get(
    "/:activityId/assessments/:assessmentId",
    {
      schema: {
        tags,
        summary: "An allocated assessment with the (anonymized) submission and rubric",
        params: params.extend({ assessmentId: zId }),
        response: {
          200: z.object({
            id: zId,
            submission: zSubmission.omit({ grade: true, gradeOverride: true }),
            isOwnSubmission: z.boolean(),
            criteria: z.array(zCriterion),
            scores: z.record(z.string(), z.number()).nullable(),
            feedback: z.string().nullable(),
            grade: z.number().nullable(),
            submittedAt: zNullableDate,
            canEdit: z.boolean(),
          }),
        },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const ctx = await loadWorkshop(tx, req, req.params.activityId);
        const { a, s } = await loadAssessment(tx, ctx, req.params.assessmentId);
        if (!ctx.canManage && ctx.workshop.phase === "setup") throw notFound("Assessment");
        if (!ctx.canManage && ctx.workshop.phase === "submission") throw new AppError(409, "WRONG_PHASE", "Assessment has not started yet");
        const { grade: _g, gradeOverride: _o, ...submission } = await toSubmission(tx, s);
        const deadlineOk = !ctx.workshop.assessmentEndAt || ctx.workshop.assessmentEndAt >= new Date();
        return {
          id: a.id,
          submission,
          isOwnSubmission: s.userId === ctx.me.id,
          criteria: ctx.workshop.criteria,
          scores: a.scores,
          feedback: a.feedback,
          grade: a.grade,
          submittedAt: a.submittedAt,
          canEdit: a.reviewerId === ctx.me.id && ctx.canAssess && ctx.workshop.phase === "assessment" && deadlineOk,
        };
      }),
  );

  app.put(
    "/:activityId/assessments/:assessmentId",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        tags,
        summary: "Submit (or revise) my assessment: a score per criterion and feedback",
        params: params.extend({ assessmentId: zId }),
        body: z.object({ scores: z.record(z.string(), z.number().min(0)), feedback: z.string().max(50_000).nullable().optional() }),
        response: { 200: z.object({ grade: z.number() }) },
      },
    },
    async (req) =>
      req.tenant(async (tx) => {
        const ctx = await loadWorkshop(tx, req, req.params.activityId);
        await requireCapability(tx, req, "workshop:peer_assess", ctx.activity.contextId);
        const { a } = await loadAssessment(tx, ctx, req.params.assessmentId);
        if (a.reviewerId !== ctx.me.id) throw notFound("Assessment");
        assertPhase(ctx, "assessment");
        if (ctx.workshop.assessmentEndAt && ctx.workshop.assessmentEndAt < new Date()) throw new AppError(409, "DEADLINE_PASSED", "The assessment deadline has passed");
        let grade: number;
        try {
          grade = assessmentGrade(ctx.workshop.criteria, req.body.scores);
        } catch (err) {
          throw badRequest((err as Error).message);
        }
        const scores = Object.fromEntries(ctx.workshop.criteria.map((c) => [c.id, req.body.scores[c.id]!]));
        await tx
          .update(workshopAssessments)
          .set({ scores, grade, feedback: req.body.feedback ? cleanHtml(req.body.feedback) : null, submittedAt: new Date() })
          .where(eq(workshopAssessments.id, a.id));
        return { grade };
      }),
  );

  // ─── Evaluation ─────────────────────────────────────────────────────────

  const zGradeRow = z.object({
    user: zPerson,
    submissionId: zId.nullable(),
    submissionTitle: z.string().nullable(),
    submissionGrade: z.number().nullable(),
    gradeOverride: z.number().nullable(),
    gradingGrade: z.number().nullable(),
    total: z.number().nullable(),
    assessmentsGiven: z.number().int(),
    assessmentsDone: z.number().int(),
  });

  app.get(
    "/:activityId/grades",
    { schema: { tags, summary: "Grade breakdown per participant (workshop:manage)", params, response: { 200: z.array(zGradeRow) } } },
    (req) =>
      req.tenant(async (tx) => {
        const ctx = await loadWorkshop(tx, req, req.params.activityId);
        requireManage(ctx);
        const rows = await gradeBreakdown(tx, ctx.workshop);
        const people = await userSummaries(tx, rows.map((r) => r.userId));
        return rows
          .map((r) => ({
            user: people.get(r.userId) ?? { id: r.userId, firstName: "Unknown", lastName: "user" },
            submissionId: r.submission?.id ?? null,
            submissionTitle: r.submission?.title ?? null,
            submissionGrade: r.submission?.grade ?? null,
            gradeOverride: r.submission?.gradeOverride ?? null,
            gradingGrade: r.gradingGrade,
            total: r.total,
            assessmentsGiven: r.assessmentsGiven,
            assessmentsDone: r.assessmentsDone,
          }))
          .sort((a, b) => a.user.lastName.localeCompare(b.user.lastName) || a.user.firstName.localeCompare(b.user.firstName));
      }),
  );

  app.post(
    "/:activityId/evaluate",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags,
        summary: "Calculate submission and grading grades and push them to the gradebook (evaluation phase)",
        params,
        response: { 200: z.object({ graded: z.number().int() }) },
      },
    },
    async (req) => {
      const out = await req.tenant(async (tx) => {
        const ctx = await loadWorkshop(tx, req, req.params.activityId);
        requireManage(ctx);
        assertPhase(ctx, "evaluation", "closed");
        const w = ctx.workshop;
        const subs = await submissionsOf(tx, w.id);
        const assessments = subs.length ? await tx.select().from(workshopAssessments).where(inArray(workshopAssessments.submissionId, subs.map((s) => s.id))) : [];
        const result = computeWorkshopGrades({
          assessments: assessments.map((a) => ({ id: a.id, submissionId: a.submissionId, reviewerId: a.reviewerId, grade: a.submittedAt ? a.grade : null })),
          submissionGradeMax: w.submissionGradeMax,
          assessmentGradeMax: w.assessmentGradeMax,
        });
        for (const s of subs) {
          await tx.update(workshopSubmissions).set({ grade: result.submissionGrades.get(s.id) ?? null }).where(eq(workshopSubmissions.id, s.id));
        }
        for (const a of assessments) {
          await tx.update(workshopAssessments).set({ gradingGrade: result.assessmentQuality.get(a.id) ?? null }).where(eq(workshopAssessments.id, a.id));
        }
        const payloads: EventMap["grade.updated"][] = [];
        for (const row of await gradeBreakdown(tx, w)) {
          const p = await pushWorkshopGrade(tx, { activity: ctx.activity, userId: row.userId, total: row.total, gradedBy: ctx.me.id });
          if (p) payloads.push(p);
        }
        await audit(tx, req, "workshop.grades_calculated", { type: "activity", id: ctx.activity.id }, { graded: payloads.length });
        return payloads;
      });
      for (const p of out) await emit("grade.updated", p);
      return { graded: out.length };
    },
  );
};
