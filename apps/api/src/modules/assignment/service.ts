import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import {
  activities,
  assignmentFeedback,
  assignmentSubmissions,
  assignments,
  enrolments,
  files,
  roleAssignments,
  roles,
  submissionFiles,
  users,
  type DB,
} from "@lms/db";
import { z } from "zod";
import { registerActivityType, type ActivityRow } from "../../core/activity-types";
import { assertAllowedType, assertOwnFiles, registerFileAccess } from "../../core/files";
import { badRequest, must } from "../../core/errors";
import { hasCapability } from "../../core/rbac";
import { cleanHtml } from "../../core/sanitize";
import { zDateInput } from "../../core/schemas";
import { loadActivity } from "../activities/service";

export type AssignmentRow = typeof assignments.$inferSelect;
export type SubmissionRow = typeof assignmentSubmissions.$inferSelect;

// ─── Activity type ──────────────────────────────────────────────────────────

const MAX_FILE_BYTES = 200 * 1024 * 1024;

export const assignmentSettings = z.object({
  instructions: z.string().max(50_000).nullable().optional(),
  allowText: z.boolean().default(true),
  allowFiles: z.boolean().default(true),
  maxFiles: z.number().int().min(1).max(50).default(5),
  maxFileBytes: z
    .number()
    .int()
    .min(1024)
    .max(MAX_FILE_BYTES)
    .default(20 * 1024 * 1024),
  /** Extensions (".pdf") or MIME types; empty = anything the platform allows. */
  acceptedTypes: z.array(z.string().trim().min(1).max(100)).max(30).default([]),
  dueAt: zDateInput.nullable().optional(),
  cutoffAt: zDateInput.nullable().optional(),
  allowResubmit: z.boolean().default(true),
  gradeMax: z.number().positive().max(10_000).default(100),
  gradePass: z.number().min(0).max(10_000).nullable().optional(),
  blindMarking: z.boolean().default(false),
});
type Settings = z.infer<typeof assignmentSettings>;

function normalise(s: Partial<Settings>) {
  const out: Partial<typeof assignments.$inferInsert> = {};
  for (const key of Object.keys(s) as (keyof Settings)[]) {
    if (s[key] !== undefined) (out as Record<string, unknown>)[key] = s[key];
  }
  if (s.instructions !== undefined) out.instructions = s.instructions ? cleanHtml(s.instructions) : null;
  return out;
}

function validate(a: Partial<AssignmentRow>) {
  if (a.allowText === false && a.allowFiles === false) throw badRequest("Allow online text, file submissions, or both");
  if (a.dueAt && a.cutoffAt && a.cutoffAt < a.dueAt) throw badRequest("The cut-off date cannot be before the due date");
  if (a.gradePass != null && a.gradeMax != null && a.gradePass > a.gradeMax) throw badRequest("The pass grade cannot exceed the maximum grade");
}

export async function assignmentOf(tx: DB, activityId: string) {
  return must((await tx.select().from(assignments).where(eq(assignments.activityId, activityId)).limit(1))[0], "Assignment");
}

export function registerAssignmentType() {
  registerActivityType({
    type: "assignment",
    label: "Assignment",
    settings: assignmentSettings,
    async create(tx, ctx, settings) {
      const values = normalise(settings);
      validate(values);
      await tx.insert(assignments).values({ ...values, organizationId: ctx.organizationId, activityId: ctx.activity.id });
    },
    async update(tx, ctx, settings) {
      const current = await assignmentOf(tx, ctx.activity.id);
      const patch = normalise(settings);
      validate({ ...current, ...patch });
      if (Object.keys(patch).length) await tx.update(assignments).set(patch).where(eq(assignments.id, current.id));
    },
    async load(tx, activity) {
      const [a] = await tx.select().from(assignments).where(eq(assignments.activityId, activity.id)).limit(1);
      if (!a) return null;
      return {
        instructions: a.instructions,
        allowText: a.allowText,
        allowFiles: a.allowFiles,
        maxFiles: a.maxFiles,
        maxFileBytes: a.maxFileBytes,
        acceptedTypes: a.acceptedTypes,
        dueAt: a.dueAt?.toISOString() ?? null,
        cutoffAt: a.cutoffAt?.toISOString() ?? null,
        allowResubmit: a.allowResubmit,
        gradeMax: a.gradeMax,
        gradePass: a.gradePass,
        blindMarking: a.blindMarking,
      };
    },
    async grading(tx, activity) {
      const a = await assignmentOf(tx, activity.id);
      return { gradeMax: a.gradeMax, gradePass: a.gradePass };
    },
  });

  // Submission files: the submitter (owner rule in core) and anyone who can view submissions in that activity.
  registerFileAccess("assignment", async (tx, req, file) => {
    if (!req.user || !file.contextId) return false;
    if (file.ownerId === req.user.id) return true;
    return hasCapability(tx, req, "assignment:view_submissions", file.contextId);
  });
}

// ─── Loading ────────────────────────────────────────────────────────────────

export async function loadAssignment(tx: DB, req: FastifyRequest, activityId: string, opts: Parameters<typeof loadActivity>[3] = {}) {
  const { activity, course, canEdit } = await loadActivity(tx, req, activityId, { ...opts, type: "assignment" });
  return { activity, course, canEdit, assignment: await assignmentOf(tx, activity.id) };
}

/** Latest attempt of a user's submission (null when they never started one). */
export async function latestSubmission(tx: DB, assignmentId: string, userId: string) {
  const [row] = await tx
    .select()
    .from(assignmentSubmissions)
    .where(and(eq(assignmentSubmissions.assignmentId, assignmentId), eq(assignmentSubmissions.userId, userId)))
    .orderBy(desc(assignmentSubmissions.attempt))
    .limit(1);
  return row ?? null;
}

export async function filesOf(tx: DB, submissionId: string) {
  return tx
    .select({ id: files.id, filename: files.filename, mimeType: files.mimeType, size: files.size })
    .from(submissionFiles)
    .innerJoin(files, eq(files.id, submissionFiles.fileId))
    .where(and(eq(submissionFiles.submissionId, submissionId), isNull(files.deletedAt)))
    .orderBy(asc(files.filename));
}

export async function feedbackOf(tx: DB, submissionId: string) {
  const [row] = await tx
    .select({ f: assignmentFeedback, grader: { id: users.id, firstName: users.firstName, lastName: users.lastName } })
    .from(assignmentFeedback)
    .leftJoin(users, eq(users.id, assignmentFeedback.graderId))
    .where(eq(assignmentFeedback.submissionId, submissionId))
    .limit(1);
  return row ? { ...row.f, grader: row.grader } : null;
}

/** Most recent feedback across a user's attempts (a reopened attempt keeps showing the last grade). */
export async function latestFeedbackFor(tx: DB, assignmentId: string, userId: string) {
  const [row] = await tx
    .select({ f: assignmentFeedback, attempt: assignmentSubmissions.attempt })
    .from(assignmentFeedback)
    .innerJoin(assignmentSubmissions, eq(assignmentSubmissions.id, assignmentFeedback.submissionId))
    .where(and(eq(assignmentSubmissions.assignmentId, assignmentId), eq(assignmentSubmissions.userId, userId)))
    .orderBy(desc(assignmentSubmissions.attempt))
    .limit(1);
  return row ? { ...row.f, attempt: row.attempt } : null;
}

// ─── Draft content ──────────────────────────────────────────────────────────

/**
 * Replaces the submission's text and files. Files must belong to the user and
 * satisfy the assignment's limits; they are re-tagged so the assignment file
 * access rule applies (submitter + graders).
 */
export async function saveContent(
  tx: DB,
  req: FastifyRequest,
  input: { assignment: AssignmentRow; activity: ActivityRow; submission: SubmissionRow; text: string | null; fileIds: string[] },
) {
  const { assignment, activity, submission } = input;
  const fileIds = [...new Set(input.fileIds)];
  if (!assignment.allowText && input.text?.trim()) throw badRequest("Online text is not accepted for this assignment");
  if (!assignment.allowFiles && fileIds.length) throw badRequest("Files are not accepted for this assignment");
  if (fileIds.length > assignment.maxFiles) throw badRequest(`At most ${assignment.maxFiles} files`);

  if (fileIds.length) {
    await assertOwnFiles(tx, req, fileIds);
    const rows = await tx.select().from(files).where(inArray(files.id, fileIds));
    for (const f of rows) {
      if (f.deletedAt) throw badRequest(`Invalid file ${f.id}`);
      if (f.size > assignment.maxFileBytes) throw badRequest(`${f.filename} is larger than ${Math.round(assignment.maxFileBytes / 1024 / 1024)} MB`);
      assertAllowedType(f.filename, f.mimeType, assignment.acceptedTypes);
      // A file attached to another assignment/submission can't be re-used here.
      if (f.component === "assignment" && f.itemId && f.itemId !== submission.id) {
        const [link] = await tx
          .select({ id: submissionFiles.id })
          .from(submissionFiles)
          .innerJoin(assignmentSubmissions, eq(assignmentSubmissions.id, submissionFiles.submissionId))
          .where(
            and(eq(submissionFiles.fileId, f.id), eq(assignmentSubmissions.assignmentId, assignment.id), eq(assignmentSubmissions.userId, submission.userId)),
          )
          .limit(1);
        if (!link) throw badRequest(`Invalid file ${f.id}`);
      } else if (f.component !== "assignment" && f.component !== "draft") {
        throw badRequest(`Invalid file ${f.id}`);
      }
    }
  }

  await tx.delete(submissionFiles).where(eq(submissionFiles.submissionId, submission.id));
  if (fileIds.length) {
    await tx.insert(submissionFiles).values(fileIds.map((fileId) => ({ organizationId: submission.organizationId, submissionId: submission.id, fileId })));
    await tx
      .update(files)
      .set({ component: "assignment", area: "submission", itemId: submission.id, contextId: activity.contextId })
      .where(inArray(files.id, fileIds));
  }
  const [updated] = await tx
    .update(assignmentSubmissions)
    .set({ text: input.text?.trim() ? cleanHtml(input.text) : null, status: "draft" })
    .where(eq(assignmentSubmissions.id, submission.id))
    .returning();
  return updated!;
}

// ─── Participants ───────────────────────────────────────────────────────────

/** Active enrolled learners (student role in the course or the activity). */
export async function studentsOf(tx: DB, activity: ActivityRow, courseContextId: string) {
  const rows = await tx
    .selectDistinct({ id: users.id, firstName: users.firstName, lastName: users.lastName, email: users.email })
    .from(enrolments)
    .innerJoin(users, eq(users.id, enrolments.userId))
    .innerJoin(roleAssignments, and(eq(roleAssignments.userId, enrolments.userId), inArray(roleAssignments.contextId, [courseContextId, activity.contextId])))
    .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
    .where(and(eq(enrolments.courseId, activity.courseId), eq(enrolments.status, "active"), eq(roles.archetype, "student"), isNull(users.deletedAt)));
  return rows.sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName));
}

/** Graders to notify about a submission: teachers assigned in the course or activity. */
export async function gradersOf(tx: DB, activity: ActivityRow, courseContextId: string) {
  const rows = await tx
    .selectDistinct({ id: roleAssignments.userId })
    .from(roleAssignments)
    .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
    .where(and(inArray(roleAssignments.contextId, [courseContextId, activity.contextId]), inArray(roles.archetype, ["editing_teacher", "teacher"])));
  return rows.map((r) => r.id);
}

export async function activityRow(tx: DB, id: string) {
  return must((await tx.select().from(activities).where(eq(activities.id, id)).limit(1))[0], "Activity");
}
