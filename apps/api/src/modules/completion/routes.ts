import { and, asc, eq, inArray } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { activities, activityCompletions, courseCompletions, courseSections } from "@lms/db";
import { z } from "zod";
import { audit } from "../../core/audit";
import { requireUser } from "../../core/auth";
import { badRequest, forbidden, notFound } from "../../core/errors";
import { hasCapability } from "../../core/rbac";
import { offset, paged, zId, zNullableDate, zPagination, zUserSummary } from "../../core/schemas";
import { loadActivity } from "../activities/service";
import { loadCourse, loadCourseWith } from "../courses/service";
import { gradebookUsers } from "../gradebook/service";
import { emitFollowUps } from "./follow-ups";
import { COMPLETION_STATES, courseProgress, isDone, type CompletionRule, type CompletionState } from "./rules";
import { evaluateCourseCompletion, isActiveParticipant, setActivityCompletion, statesFor, trackedCourseActivities } from "./service";

const zState = z.enum(COMPLETION_STATES);
const zRule = z.enum(["none", "manual", "view", "submit", "grade", "pass"]);

export const routes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    "/activities/:activityId/manual",
    {
      schema: {
        tags: ["Completion"],
        summary: "Mark an activity with a manual completion rule as done / not done",
        params: z.object({ activityId: zId }),
        body: z.object({ completed: z.boolean() }),
        response: { 200: z.object({ state: zState }) },
      },
    },
    async (req) => {
      const me = requireUser(req);
      const state = await req.tenant(async (tx) => {
        const { activity, course } = await loadActivity(tx, req, req.params.activityId);
        if (activity.completionRule !== "manual") throw badRequest("This activity is not marked complete manually");
        if (!course.enableCompletion) throw badRequest("Completion tracking is disabled in this course");
        if (!(await isActiveParticipant(tx, course.id, me.id))) throw forbidden("Only course participants can track completion");
        const result = await setActivityCompletion(tx, {
          activity,
          userId: me.id,
          state: req.body.completed ? "complete" : "incomplete",
          automatic: false,
          overriddenBy: null,
        });
        const courseFollowUps = result.changed && isDone(result.state) ? await evaluateCourseCompletion(tx, course, me.id) : [];
        await emitFollowUps(tx, [...result.followUps, ...courseFollowUps]);
        return result.state;
      });
      return { state };
    },
  );

  app.post(
    "/activities/:activityId/users/:userId/override",
    {
      schema: {
        tags: ["Completion"],
        summary: "Override a learner's activity completion (teacher)",
        params: z.object({ activityId: zId, userId: zId }),
        body: z.object({ state: zState }),
        response: { 200: z.object({ state: zState }) },
      },
    },
    async (req) => {
      const me = requireUser(req);
      const state = await req.tenant(async (tx) => {
        const { activity, course } = await loadActivity(tx, req, req.params.activityId, { capability: "completion:override" });
        if (activity.completionRule === "none") throw badRequest("This activity does not track completion");
        if (!(await isActiveParticipant(tx, course.id, req.params.userId))) throw notFound("User");
        const result = await setActivityCompletion(tx, {
          activity,
          userId: req.params.userId,
          state: req.body.state,
          automatic: false,
          overriddenBy: me.id,
        });
        await audit(tx, req, "completion.overridden", { type: "activity", id: activity.id }, { userId: req.params.userId, state: req.body.state });
        const courseFollowUps = result.changed && isDone(result.state) ? await evaluateCourseCompletion(tx, course, req.params.userId) : [];
        await emitFollowUps(tx, [...result.followUps, ...courseFollowUps]);
        return result.state;
      });
      return { state };
    },
  );

  app.get(
    "/courses/:courseId",
    {
      schema: {
        tags: ["Completion"],
        summary: "Completion report: activities × learners (paged by learner)",
        params: z.object({ courseId: zId }),
        querystring: zPagination.extend({ search: z.string().max(100).optional() }),
        response: {
          200: z.object({
            course: z.object({ id: zId, fullname: z.string(), enableCompletion: z.boolean() }),
            activities: z.array(z.object({ id: zId, name: z.string(), type: z.string(), completionRule: zRule, visible: z.boolean() })),
            users: paged(zUserSummary.extend({ completedAt: zNullableDate, progress: z.number().int() })),
            states: z.array(z.object({ activityId: zId, userId: zId, state: zState, completedAt: zNullableDate, overridden: z.boolean() })),
            canOverride: z.boolean(),
          }),
        },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const course = await loadCourseWith(tx, req, req.params.courseId, "report:view_course");
        const q = req.query;
        const acts = (
          await tx
            .select({ a: activities })
            .from(activities)
            .innerJoin(courseSections, eq(courseSections.id, activities.sectionId))
            .where(eq(activities.courseId, course.id))
            .orderBy(asc(courseSections.position), asc(activities.position))
        )
          .map((r) => r.a)
          .filter((a) => a.completionRule !== "none");
        const learners = await gradebookUsers(tx, course);
        const needle = q.search?.toLowerCase().trim();
        const filtered = needle ? learners.filter((u) => `${u.firstName} ${u.lastName} ${u.email}`.toLowerCase().includes(needle)) : learners;
        const page = filtered.slice(offset(q), offset(q) + q.pageSize);
        const ids = page.map((u) => u.id);
        const rows =
          ids.length && acts.length
            ? await tx
                .select()
                .from(activityCompletions)
                .where(and(inArray(activityCompletions.userId, ids), inArray(activityCompletions.activityId, acts.map((a) => a.id))))
            : [];
        const done = ids.length
          ? await tx.select().from(courseCompletions).where(and(eq(courseCompletions.courseId, course.id), inArray(courseCompletions.userId, ids)))
          : [];
        const doneAt = new Map(done.map((d) => [d.userId, d.completedAt]));
        const counted = acts.filter((a) => a.visible);
        return {
          course: { id: course.id, fullname: course.fullname, enableCompletion: course.enableCompletion },
          activities: acts.map((a) => ({ id: a.id, name: a.name, type: a.type, completionRule: a.completionRule as CompletionRule, visible: a.visible })),
          users: {
            items: page.map((u) => {
              const mine = new Map(rows.filter((r) => r.userId === u.id).map((r) => [r.activityId, r.state as CompletionState]));
              return {
                ...u,
                completedAt: doneAt.get(u.id) ?? null,
                progress: courseProgress(counted.map((a) => ({ id: a.id, completionRule: a.completionRule as CompletionRule })), mine).percentage,
              };
            }),
            total: filtered.length,
            page: q.page,
            pageSize: q.pageSize,
          },
          states: rows.map((r) => ({
            activityId: r.activityId,
            userId: r.userId,
            state: r.state as CompletionState,
            completedAt: r.completedAt,
            overridden: !!r.overriddenBy,
          })),
          canOverride: await hasCapability(tx, req, "completion:override", course.contextId),
        };
      }),
  );

  app.get(
    "/courses/:courseId/me",
    {
      schema: {
        tags: ["Completion"],
        summary: "My completion progress in a course",
        params: z.object({ courseId: zId }),
        response: {
          200: z.object({
            enabled: z.boolean(),
            total: z.number().int(),
            completed: z.number().int(),
            percentage: z.number().int(),
            completedAt: zNullableDate,
            activities: z.array(z.object({ id: zId, name: z.string(), type: z.string(), completionRule: zRule, state: zState })),
          }),
        },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const me = requireUser(req);
        const course = await loadCourse(tx, req, req.params.courseId);
        const tracked = course.enableCompletion ? await trackedCourseActivities(tx, course.id) : [];
        const stateOf = await statesFor(tx, me.id, tracked.map((a) => a.id));
        const progress = courseProgress(tracked.map((a) => ({ id: a.id, completionRule: a.completionRule as CompletionRule })), stateOf);
        const [done] = await tx
          .select({ completedAt: courseCompletions.completedAt })
          .from(courseCompletions)
          .where(and(eq(courseCompletions.courseId, course.id), eq(courseCompletions.userId, me.id)))
          .limit(1);
        return {
          enabled: course.enableCompletion,
          total: progress.total,
          completed: progress.completed,
          percentage: progress.percentage,
          completedAt: done?.completedAt ?? null,
          activities: tracked.map((a) => ({
            id: a.id,
            name: a.name,
            type: a.type,
            completionRule: a.completionRule as CompletionRule,
            state: stateOf.get(a.id) ?? "incomplete",
          })),
        };
      }),
  );
};
