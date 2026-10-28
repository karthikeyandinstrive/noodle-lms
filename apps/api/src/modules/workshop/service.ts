import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { activities, files, workshopAssessments, workshopSubmissions, workshops, type DB } from "@lms/db";
import { z } from "zod";
import { registerActivityType, type ActivityRow } from "../../core/activity-types";
import { requireUser } from "../../core/auth";
import type { EventMap } from "../../core/events";
import { badRequest, must } from "../../core/errors";
import { registerFileAccess } from "../../core/files";
import { hasCapability } from "../../core/rbac";
import { cleanHtml } from "../../core/sanitize";
import { zDateInput } from "../../core/schemas";
import { loadActivity } from "../activities/service";
import { pushGrade } from "../gradebook/service";
import { totalGrade } from "./logic";

export type WorkshopRow = typeof workshops.$inferSelect;
export type SubmissionRow = typeof workshopSubmissions.$inferSelect;
export type AssessmentRow = typeof workshopAssessments.$inferSelect;
export const PHASES = ["setup", "submission", "assessment", "evaluation", "closed"] as const;
export type Phase = (typeof PHASES)[number];

const zCriterion = z.object({
  id: z.string().trim().min(1).max(64),
  description: z.string().trim().min(1).max(2000),
  maxScore: z.number().positive().max(1000),
  weight: z.number().min(0).max(100),
});

export const workshopSettings = z.object({
  instructions: z.string().max(50_000).nullable().optional(),
  assessmentInstructions: z.string().max(50_000).nullable().optional(),
  submissionEndAt: zDateInput.nullable().optional(),
  assessmentEndAt: zDateInput.nullable().optional(),
  submissionGradeMax: z.number().min(0).max(1000).default(80),
  assessmentGradeMax: z.number().min(0).max(1000).default(20),
  reviewsPerSubmission: z.number().int().min(0).max(20).default(3),
  allowSelfAssessment: z.boolean().default(false),
  criteria: z.array(zCriterion).max(50).default([]),
});

function checkCriteria(criteria: z.infer<typeof zCriterion>[]) {
  const ids = criteria.map((c) => c.id);
  if (new Set(ids).size !== ids.length) throw badRequest("Criterion ids must be unique");
  if (criteria.length && !criteria.some((c) => c.weight > 0)) throw badRequest("At least one criterion needs a weight above 0");
}

export async function workshopOf(tx: DB, activityId: string) {
  return must((await tx.select().from(workshops).where(eq(workshops.activityId, activityId)).limit(1))[0], "Workshop");
}

export function registerWorkshop() {
  registerActivityType({
    type: "workshop",
    label: "Workshop",
    settings: workshopSettings,
    async create(tx, ctx, s) {
      checkCriteria(s.criteria);
      await tx.insert(workshops).values({
        organizationId: ctx.organizationId,
        activityId: ctx.activity.id,
        instructions: s.instructions ? cleanHtml(s.instructions) : null,
        assessmentInstructions: s.assessmentInstructions ? cleanHtml(s.assessmentInstructions) : null,
        submissionEndAt: s.submissionEndAt ?? null,
        assessmentEndAt: s.assessmentEndAt ?? null,
        submissionGradeMax: s.submissionGradeMax,
        assessmentGradeMax: s.assessmentGradeMax,
        reviewsPerSubmission: s.reviewsPerSubmission,
        allowSelfAssessment: s.allowSelfAssessment,
        criteria: s.criteria,
      });
    },
    async update(tx, ctx, s) {
      const w = await workshopOf(tx, ctx.activity.id);
      const patch: Partial<typeof workshops.$inferInsert> = {};
      if (s.criteria !== undefined) {
        checkCriteria(s.criteria);
        if (JSON.stringify(s.criteria) !== JSON.stringify(w.criteria)) {
          const [assessed] = await tx
            .select({ id: workshopAssessments.id })
            .from(workshopAssessments)
            .innerJoin(workshopSubmissions, eq(workshopSubmissions.id, workshopAssessments.submissionId))
            .where(and(eq(workshopSubmissions.workshopId, w.id), isNotNull(workshopAssessments.submittedAt)))
            .limit(1);
          if (assessed) throw badRequest("The rubric cannot change once assessments have been submitted");
        }
        patch.criteria = s.criteria;
      }
      if (s.instructions !== undefined) patch.instructions = s.instructions ? cleanHtml(s.instructions) : null;
      if (s.assessmentInstructions !== undefined) patch.assessmentInstructions = s.assessmentInstructions ? cleanHtml(s.assessmentInstructions) : null;
      if (s.submissionEndAt !== undefined) patch.submissionEndAt = s.submissionEndAt;
      if (s.assessmentEndAt !== undefined) patch.assessmentEndAt = s.assessmentEndAt;
      if (s.submissionGradeMax !== undefined) patch.submissionGradeMax = s.submissionGradeMax;
      if (s.assessmentGradeMax !== undefined) patch.assessmentGradeMax = s.assessmentGradeMax;
      if (s.reviewsPerSubmission !== undefined) patch.reviewsPerSubmission = s.reviewsPerSubmission;
      if (s.allowSelfAssessment !== undefined) patch.allowSelfAssessment = s.allowSelfAssessment;
      if (Object.keys(patch).length) await tx.update(workshops).set(patch).where(eq(workshops.id, w.id));
    },
    async load(tx, activity) {
      const [w] = await tx.select().from(workshops).where(eq(workshops.activityId, activity.id)).limit(1);
      if (!w) return null;
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
      };
    },
    async grading(tx, activity) {
      const [w] = await tx.select().from(workshops).where(eq(workshops.activityId, activity.id)).limit(1);
      return { gradeMax: (w?.submissionGradeMax ?? 80) + (w?.assessmentGradeMax ?? 20), gradePass: null };
    },
  });

  // Submission files: the author (core rule), workshop managers and allocated reviewers.
  registerFileAccess("workshop", async (tx, req, file) => {
    if (!req.user || !file.itemId) return false;
    const [row] = await tx
      .select({ submission: workshopSubmissions, contextId: activities.contextId })
      .from(workshopSubmissions)
      .innerJoin(workshops, eq(workshops.id, workshopSubmissions.workshopId))
      .innerJoin(activities, eq(activities.id, workshops.activityId))
      .where(eq(workshopSubmissions.id, file.itemId))
      .limit(1);
    if (!row || !row.submission.fileIds.includes(file.id)) return false;
    if (row.submission.userId === req.user.id) return true;
    if (await hasCapability(tx, req, "workshop:manage", row.contextId)) return true;
    const [allocated] = await tx
      .select({ id: workshopAssessments.id })
      .from(workshopAssessments)
      .where(and(eq(workshopAssessments.submissionId, row.submission.id), eq(workshopAssessments.reviewerId, req.user.id)))
      .limit(1);
    return !!allocated && (await hasCapability(tx, req, "course:view", row.contextId));
  });
}

export async function loadWorkshop(tx: DB, req: FastifyRequest, activityId: string) {
  const me = requireUser(req);
  const { activity, course } = await loadActivity(tx, req, activityId, { type: "workshop" });
  const workshop = await workshopOf(tx, activity.id);
  const [canManage, canSubmit, canAssess] = [
    await hasCapability(tx, req, "workshop:manage", activity.contextId),
    await hasCapability(tx, req, "workshop:submit", activity.contextId),
    await hasCapability(tx, req, "workshop:peer_assess", activity.contextId),
  ];
  return { me, activity, course, workshop, canManage, canSubmit, canAssess };
}
export type WorkshopCtx = Awaited<ReturnType<typeof loadWorkshop>>;

export async function fileSummaries(tx: DB, ids: string[]) {
  if (!ids.length) return [];
  const rows = await tx
    .select({ id: files.id, filename: files.filename, mimeType: files.mimeType, size: files.size })
    .from(files)
    .where(inArray(files.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((f): f is NonNullable<typeof f> => !!f);
}

/** Scaled grading grade of a reviewer from the stored per-assessment quality (0–100). */
export function reviewerGrade(qualities: (number | null)[], assessmentGradeMax: number) {
  const qs = qualities.filter((q): q is number => q !== null);
  if (!qs.length) return null;
  return Math.round((qs.reduce((a, b) => a + b, 0) / qs.length / 100) * assessmentGradeMax * 1e5) / 1e5;
}

/** Per-participant grade breakdown from stored submission/assessment grades. */
export async function gradeBreakdown(tx: DB, workshop: WorkshopRow) {
  const subs = await tx.select().from(workshopSubmissions).where(eq(workshopSubmissions.workshopId, workshop.id));
  const assessments = subs.length
    ? await tx.select().from(workshopAssessments).where(inArray(workshopAssessments.submissionId, subs.map((s) => s.id)))
    : [];
  const users = new Set<string>([...subs.map((s) => s.userId), ...assessments.map((a) => a.reviewerId)]);
  return [...users].map((userId) => {
    const sub = subs.find((s) => s.userId === userId) ?? null;
    const given = assessments.filter((a) => a.reviewerId === userId);
    const grading = reviewerGrade(given.map((a) => a.gradingGrade), workshop.assessmentGradeMax);
    return {
      userId,
      submission: sub,
      assessmentsGiven: given.length,
      assessmentsDone: given.filter((a) => a.submittedAt).length,
      gradingGrade: grading,
      total: totalGrade({ submission: sub?.grade ?? null, override: sub?.gradeOverride ?? null, grading }),
    };
  });
}

/** Pushes one participant's total to the gradebook; returns the grade.updated payload (emit after commit). */
export async function pushWorkshopGrade(
  tx: DB,
  input: { activity: ActivityRow; userId: string; total: number | null; gradedBy: string },
): Promise<EventMap["grade.updated"] | null> {
  if (input.total === null) return null;
  return pushGrade(tx, {
    organizationId: input.activity.organizationId,
    activityId: input.activity.id,
    userId: input.userId,
    rawGrade: input.total,
    gradedBy: input.gradedBy,
    source: "workshop",
  });
}
