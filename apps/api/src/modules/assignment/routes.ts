import { and, desc, eq, inArray } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { assignmentFeedback, assignmentSubmissions, submissionFiles, users, type DB } from "@lms/db";
import { z } from "zod";
import { requireUser } from "../../core/auth";
import { audit } from "../../core/audit";
import { hmac } from "../../core/crypto";
import { badRequest, conflict, forbidden, notFound } from "../../core/errors";
import { emit, type EventMap } from "../../core/events";
import { notify } from "../../core/notify";
import { hasCapability } from "../../core/rbac";
import { cleanHtml } from "../../core/sanitize";
import { zDate, zId, zNullableDate } from "../../core/schemas";
import { pushGrade } from "../gradebook/service";
import { isLate, isPastCutoff, participantNumbersFor, submissionState } from "./rules";
import { feedbackOf, filesOf, gradersOf, latestFeedbackFor, latestSubmission, loadAssignment, saveContent, studentsOf } from "./service";

/** Stable blind-marking numbers, keyed with the server secret so they can't be computed from ids. */
const participantNumbers = (assignmentId: string, userIds: string[]) =>
  participantNumbersFor(assignmentId, userIds, (m) => Buffer.from(hmac(`blind:${m}`), "base64url").readUInt32BE(0));

// ─── Schemas ────────────────────────────────────────────────────────────────

const zStatus = z.enum(["draft", "submitted", "graded", "reopened"]);
const zFile = z.object({ id: zId, filename: z.string(), mimeType: z.string(), size: z.number() });
const zSubmission = z.object({
  id: zId,
  attempt: z.number().int(),
  status: zStatus,
  text: z.string().nullable(),
  submittedAt: zNullableDate,
  late: z.boolean(),
  createdAt: zDate,
  updatedAt: zDate,
  files: z.array(zFile),
});
const zFeedback = z.object({
  grade: z.number().nullable(),
  feedback: z.string().nullable(),
  gradedAt: zDate,
  attempt: z.number().int(),
  /** Hidden from learners when blind marking is on. */
  grader: z.object({ id: zId, firstName: z.string(), lastName: z.string() }).nullable().optional(),
});
const zAttemptSummary = z.object({ id: zId, attempt: z.number().int(), status: zStatus, submittedAt: zNullableDate, late: z.boolean() });

/** A participant as a grader sees them; names are omitted under blind marking. */
const zParticipant = z.object({
  userId: zId,
  displayName: z.string(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  email: z.string().optional(),
  participantNumber: z.number().int().optional(),
});

const params = z.object({ activityId: zId });
const userParams = params.extend({ userId: zId });

type GradeEvent = EventMap["grade.updated"];

export const routes: FastifyPluginAsyncZod = async (app) => {
  // ─── Learner ────────────────────────────────────────────────────────────

  app.get(
    "/:activityId/me",
    {
      schema: {
        tags: ["Assignment"],
        summary: "My submission status, files and feedback",
        params,
        response: {
          200: z.object({
            submission: zSubmission.nullable(),
            feedback: zFeedback.nullable(),
            canSubmitCapability: z.boolean(),
            canEdit: z.boolean(),
            canSubmit: z.boolean(),
            reason: z.string().nullable(),
            dueAt: zNullableDate,
            cutoffAt: zNullableDate,
            serverNow: zDate,
          }),
        },
      },
    },
    async (req) => {
      const me = requireUser(req);
      return req.tenant(async (tx) => {
        const { assignment, activity } = await loadAssignment(tx, req, req.params.activityId);
        const cap = await hasCapability(tx, req, "assignment:submit", activity.contextId);
        const sub = await latestSubmission(tx, assignment.id, me.id);
        const fb = await latestFeedbackFor(tx, assignment.id, me.id);
        const state = submissionState({ status: sub?.status ?? null, allowResubmit: assignment.allowResubmit, cutoffAt: assignment.cutoffAt }, new Date());
        const attached = sub ? await filesOf(tx, sub.id) : [];
        return {
          submission: sub ? { ...sub, files: attached } : null,
          feedback: fb
            ? {
                ...fb,
                grader: assignment.blindMarking ? undefined : await graderOf(tx, fb.graderId),
              }
            : null,
          canSubmitCapability: cap,
          canEdit: cap && state.canEdit,
          canSubmit: cap && state.canSubmit && !!sub && (!!sub.text || attached.length > 0),
          reason: cap ? state.reason : "You cannot submit to this assignment",
          dueAt: assignment.dueAt,
          cutoffAt: assignment.cutoffAt,
          serverNow: new Date(),
        };
      });
    },
  );

  app.put(
    "/:activityId/draft",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        tags: ["Assignment"],
        summary: "Save my draft (text and attached files)",
        params,
        body: z.object({ text: z.string().max(200_000).nullable().default(null), fileIds: z.array(zId).max(50).default([]) }),
        response: { 200: zSubmission },
      },
    },
    async (req) => {
      const me = requireUser(req);
      return req.tenant(async (tx) => {
        const { assignment, activity } = await loadAssignment(tx, req, req.params.activityId, { capability: "assignment:submit" });
        let sub = await latestSubmission(tx, assignment.id, me.id);
        const state = submissionState({ status: sub?.status ?? null, allowResubmit: assignment.allowResubmit, cutoffAt: assignment.cutoffAt }, new Date());
        if (!state.canEdit) throw conflict(state.reason ?? "Your submission can no longer be changed");
        if (!sub) {
          const [created] = await tx
            .insert(assignmentSubmissions)
            .values({ organizationId: req.org.id, assignmentId: assignment.id, userId: me.id, attempt: 1, status: "draft" })
            .returning();
          sub = created!;
        }
        const saved = await saveContent(tx, req, { assignment, activity, submission: sub!, text: req.body.text, fileIds: req.body.fileIds });
        return { ...saved, files: await filesOf(tx, saved.id) };
      });
    },
  );

  app.post(
    "/:activityId/submit",
    {
      schema: {
        tags: ["Assignment"],
        summary: "Submit my draft for grading",
        params,
        body: z.object({}).optional(),
        response: { 200: zSubmission },
      },
    },
    async (req) => {
      const me = requireUser(req);
      const { result, activity } = await req.tenant(async (tx) => {
        const { assignment, activity, course } = await loadAssignment(tx, req, req.params.activityId, { capability: "assignment:submit" });
        const sub = await latestSubmission(tx, assignment.id, me.id);
        if (!sub) throw badRequest("Save your work before submitting");
        const now = new Date();
        if (isPastCutoff(now, assignment.cutoffAt)) throw conflict("The cut-off date has passed");
        if (sub.status === "submitted") throw conflict("Already submitted");
        if (sub.status === "graded") throw conflict("Your submission has been graded");
        const attached = await filesOf(tx, sub.id);
        if (!sub.text && !attached.length) throw badRequest("Your submission is empty");

        const [updated] = await tx
          .update(assignmentSubmissions)
          .set({ status: "submitted", submittedAt: now, late: isLate(now, assignment.dueAt) })
          .where(and(eq(assignmentSubmissions.id, sub.id), inArray(assignmentSubmissions.status, ["draft", "reopened"])))
          .returning();
        if (!updated) throw conflict("Already submitted");

        const graders = (await gradersOf(tx, activity, course.contextId)).filter((id) => id !== me.id);
        const who = assignment.blindMarking ? "A participant" : `${me.firstName} ${me.lastName}`;
        await notify(tx, {
          organizationId: req.org.id,
          userIds: graders,
          type: "assignment_submitted",
          title: `${who} submitted "${activity.name}"${updated.late ? " (late)" : ""}`,
          link: `/activities/${activity.id}/assignment/submissions?user=${me.id}`,
        });
        return { result: { ...updated, files: attached }, activity };
      });
      const base = { organizationId: req.org.id, activityId: activity.id, courseId: activity.courseId, userId: me.id };
      await emit("assignment.submitted", { ...base, submissionId: result.id });
      await emit("activity.submitted", base);
      return result;
    },
  );

  // ─── Graders ────────────────────────────────────────────────────────────

  app.get(
    "/:activityId/submissions",
    {
      schema: {
        tags: ["Assignment"],
        summary: "Every enrolled learner with their latest submission and grade (graders)",
        params,
        response: {
          200: z.object({
            blindMarking: z.boolean(),
            gradeMax: z.number(),
            dueAt: zNullableDate,
            counts: z.object({ participants: z.number().int(), submitted: z.number().int(), needsGrading: z.number().int(), graded: z.number().int() }),
            items: z.array(
              zParticipant.extend({
                submission: zAttemptSummary.nullable(),
                grade: z.number().nullable(),
                gradedAt: zNullableDate,
                needsGrading: z.boolean(),
              }),
            ),
          }),
        },
      },
    },
    async (req) => {
      requireUser(req);
      return req.tenant(async (tx) => {
        const { assignment, activity, course } = await loadAssignment(tx, req, req.params.activityId, { capability: "assignment:view_submissions" });
        const students = await studentsOf(tx, activity, course.contextId);
        const subs = await tx
          .select()
          .from(assignmentSubmissions)
          .where(eq(assignmentSubmissions.assignmentId, assignment.id))
          .orderBy(desc(assignmentSubmissions.attempt));
        const latestOf = new Map<string, (typeof subs)[number]>();
        for (const s of subs) if (!latestOf.has(s.userId)) latestOf.set(s.userId, s);

        // Learners who submitted but are no longer enrolled still appear (their work exists).
        const missing = [...latestOf.keys()].filter((id) => !students.some((s) => s.id === id));
        const extra = missing.length
          ? await tx
              .select({ id: users.id, firstName: users.firstName, lastName: users.lastName, email: users.email })
              .from(users)
              .where(inArray(users.id, missing))
          : [];
        const people = [...students, ...extra];

        const feedback = subs.length
          ? await tx
              .select({ submissionId: assignmentFeedback.submissionId, grade: assignmentFeedback.grade, gradedAt: assignmentFeedback.gradedAt })
              .from(assignmentFeedback)
              .where(
                inArray(
                  assignmentFeedback.submissionId,
                  subs.map((s) => s.id),
                ),
              )
          : [];
        const fbOf = new Map(feedback.map((f) => [f.submissionId, f]));
        const numbers = participantNumbers(
          assignment.id,
          people.map((p) => p.id),
        );

        const items = people.map((p) => {
          const sub = latestOf.get(p.id) ?? null;
          // The grade shown is the latest one given across attempts.
          const fb =
            subs
              .filter((s) => s.userId === p.id)
              .map((s) => fbOf.get(s.id))
              .find(Boolean) ?? null;
          const ownFb = sub ? fbOf.get(sub.id) : undefined;
          const needsGrading = !!sub && sub.status === "submitted" && (!ownFb || (!!sub.submittedAt && ownFb.gradedAt < sub.submittedAt));
          return {
            ...identity(p, assignment.blindMarking, numbers.get(p.id)!),
            submission: sub,
            grade: fb?.grade ?? null,
            gradedAt: fb?.gradedAt ?? null,
            needsGrading,
          };
        });
        if (assignment.blindMarking) items.sort((a, b) => (a.participantNumber ?? 0) - (b.participantNumber ?? 0));

        return {
          blindMarking: assignment.blindMarking,
          gradeMax: assignment.gradeMax,
          dueAt: assignment.dueAt,
          counts: {
            participants: items.length,
            submitted: items.filter((i) => i.submission && i.submission.status !== "draft" && i.submission.status !== "reopened").length,
            needsGrading: items.filter((i) => i.needsGrading).length,
            graded: items.filter((i) => i.grade !== null).length,
          },
          items,
        };
      });
    },
  );

  app.get(
    "/:activityId/submissions/:userId",
    {
      schema: {
        tags: ["Assignment"],
        summary: "One learner's submission, files, history and feedback (the learner or graders)",
        params: userParams,
        response: {
          200: z.object({
            participant: zParticipant,
            submission: zSubmission.nullable(),
            feedback: zFeedback.nullable(),
            attempts: z.array(zAttemptSummary),
            gradeMax: z.number(),
            blindMarking: z.boolean(),
            canGrade: z.boolean(),
          }),
        },
      },
    },
    async (req) => {
      const me = requireUser(req);
      return req.tenant(async (tx) => {
        const { assignment, activity, course } = await loadAssignment(tx, req, req.params.activityId);
        const own = req.params.userId === me.id;
        const grader = await hasCapability(tx, req, "assignment:view_submissions", activity.contextId);
        if (!own && !grader) throw notFound("Submission");
        const attempts = await tx
          .select()
          .from(assignmentSubmissions)
          .where(and(eq(assignmentSubmissions.assignmentId, assignment.id), eq(assignmentSubmissions.userId, req.params.userId)))
          .orderBy(desc(assignmentSubmissions.attempt));
        const [user] = await tx
          .select({ id: users.id, firstName: users.firstName, lastName: users.lastName, email: users.email })
          .from(users)
          .where(eq(users.id, req.params.userId))
          .limit(1);
        if (!user) throw notFound("Submission");
        const students = await studentsOf(tx, activity, course.contextId);
        if (!attempts.length && !students.some((s) => s.id === user.id)) throw notFound("Submission");

        const latest = attempts[0] ?? null;
        const fb = await latestFeedbackFor(tx, assignment.id, user.id);
        const blindForViewer = assignment.blindMarking && !own;
        const ids = [...new Set([...students.map((s) => s.id), ...attempts.map((a) => a.userId)])];
        return {
          participant: identity(user, blindForViewer, participantNumbers(assignment.id, ids).get(user.id) ?? 0),
          submission: latest ? { ...latest, files: await filesOf(tx, latest.id) } : null,
          feedback: fb ? { ...fb, grader: assignment.blindMarking && own ? undefined : await graderOf(tx, fb.graderId) } : null,
          attempts,
          gradeMax: assignment.gradeMax,
          blindMarking: assignment.blindMarking,
          canGrade: await hasCapability(tx, req, "assignment:grade", activity.contextId),
        };
      });
    },
  );

  app.post(
    "/:activityId/submissions/:userId/grade",
    {
      schema: {
        tags: ["Assignment"],
        summary: "Grade a learner and leave feedback (null grade clears it)",
        params: userParams,
        body: z.object({ grade: z.number().min(0).nullable(), feedback: z.string().max(50_000).nullable().optional() }),
        response: { 200: zFeedback },
      },
    },
    async (req) => {
      const me = requireUser(req);
      const { out, gradeEvent, activity, submissionId } = await req.tenant(async (tx) => {
        const { assignment, activity, course } = await loadAssignment(tx, req, req.params.activityId, { capability: "assignment:grade" });
        if (req.body.grade !== null && req.body.grade > assignment.gradeMax) throw badRequest(`The grade cannot exceed ${assignment.gradeMax}`);
        if (req.params.userId === me.id) throw forbidden("You cannot grade yourself");

        let sub = await latestSubmission(tx, assignment.id, req.params.userId);
        if (!sub) {
          // Grading without a submission (e.g. offline work) — only for enrolled learners.
          const students = await studentsOf(tx, activity, course.contextId);
          if (!students.some((s) => s.id === req.params.userId)) throw notFound("Participant");
          const [created] = await tx
            .insert(assignmentSubmissions)
            .values({ organizationId: req.org.id, assignmentId: assignment.id, userId: req.params.userId, attempt: 1, status: "graded" })
            .returning();
          sub = created!;
        }
        const feedback = req.body.feedback?.trim() ? cleanHtml(req.body.feedback) : null;
        const previous = await feedbackOf(tx, sub!.id);
        const values = { grade: req.body.grade, feedback, graderId: me.id, gradedAt: new Date() };
        await tx
          .insert(assignmentFeedback)
          .values({ organizationId: req.org.id, submissionId: sub!.id, ...values })
          .onConflictDoUpdate({ target: assignmentFeedback.submissionId, set: values });
        await tx.update(assignmentSubmissions).set({ status: "graded" }).where(eq(assignmentSubmissions.id, sub!.id));

        const gradeEvent: GradeEvent | null = await pushGrade(tx, {
          organizationId: req.org.id,
          activityId: activity.id,
          userId: req.params.userId,
          rawGrade: req.body.grade,
          feedback,
          gradedBy: me.id,
          source: "assignment",
        });
        await audit(
          tx,
          req,
          "assignment.graded",
          { type: "assignment_submission", id: sub!.id },
          {
            userId: req.params.userId,
            grade: req.body.grade,
            previousGrade: previous?.grade ?? null,
          },
        );
        await notify(tx, {
          organizationId: req.org.id,
          userIds: [req.params.userId],
          type: "assignment_graded",
          title: `Your submission for "${activity.name}" was graded`,
          link: `/activities/${activity.id}`,
        });
        return {
          out: { ...values, attempt: sub!.attempt, grader: { id: me.id, firstName: me.firstName, lastName: me.lastName } },
          gradeEvent,
          activity,
          submissionId: sub!.id,
        };
      });
      await emit("assignment.graded", {
        organizationId: req.org.id,
        activityId: activity.id,
        courseId: activity.courseId,
        userId: req.params.userId,
        submissionId,
      });
      if (gradeEvent) await emit("grade.updated", gradeEvent);
      return out;
    },
  );

  app.post(
    "/:activityId/submissions/:userId/reopen",
    {
      schema: {
        tags: ["Assignment"],
        summary: "Reopen a learner's submission: starts a new attempt pre-filled with the previous one",
        params: userParams,
        body: z.object({}).optional(),
        response: { 200: zAttemptSummary },
      },
    },
    async (req) =>
      req.tenant(async (tx) => {
        const { assignment } = await loadAssignment(tx, req, req.params.activityId, { capability: "assignment:grade" });
        const sub = await latestSubmission(tx, assignment.id, req.params.userId);
        if (!sub) throw notFound("Submission");
        if (sub.status !== "submitted" && sub.status !== "graded") throw conflict("Only submitted or graded work can be reopened");
        const [next] = await tx
          .insert(assignmentSubmissions)
          .values({ organizationId: req.org.id, assignmentId: assignment.id, userId: sub.userId, attempt: sub.attempt + 1, status: "reopened", text: sub.text })
          .returning();
        const links = await tx.select({ fileId: submissionFiles.fileId }).from(submissionFiles).where(eq(submissionFiles.submissionId, sub.id));
        if (links.length) {
          await tx.insert(submissionFiles).values(links.map((l) => ({ organizationId: req.org.id, submissionId: next!.id, fileId: l.fileId })));
        }
        await audit(tx, req, "assignment.reopened", { type: "assignment_submission", id: next!.id }, { userId: sub.userId, attempt: next!.attempt });
        return next!;
      }),
  );

  // ─── helpers ────────────────────────────────────────────────────────────

  function identity(u: { id: string; firstName: string; lastName: string; email: string }, blind: boolean, n: number) {
    if (blind) return { userId: u.id, displayName: `Participant ${n}`, participantNumber: n };
    return { userId: u.id, displayName: `${u.firstName} ${u.lastName}`, firstName: u.firstName, lastName: u.lastName, email: u.email };
  }

  async function graderOf(tx: DB, id: string) {
    const [u] = await tx.select({ id: users.id, firstName: users.firstName, lastName: users.lastName }).from(users).where(eq(users.id, id)).limit(1);
    return u ?? null;
  }
};
