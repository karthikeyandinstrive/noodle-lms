import { and, asc, count, countDistinct, desc, eq, gte, inArray, isNull, max, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import {
  activities,
  activityCompletions,
  courseCompletions,
  courseSections,
  courses,
  enrolments,
  eventLog,
  getSystemContext,
  gradeGrades,
  gradeItems,
  users,
  type DB,
} from "@lms/db";
import { z } from "zod";
import { requireUser } from "../../core/auth";
import { notFound } from "../../core/errors";
import { hasCapability, requireCapability } from "../../core/rbac";
import { offset, paged, zDate, zId, zNullableDate, zPagination, zUserSummary } from "../../core/schemas";
import { loadCourse, loadCourseWith } from "../courses/service";
import { gradebookUsers } from "../gradebook/service";
import { fillDays, windowStart } from "./series";

const DAY = 24 * 60 * 60 * 1000;
const zSeries = z.array(z.object({ date: z.string(), value: z.number() }));
const zActivityRef = z.object({ id: zId, name: z.string(), type: z.string() });
const courseIdParam = z.object({ courseId: zId });

const dayExpr = sql<string>`to_char(date_trunc('day', ${eventLog.createdAt} at time zone 'UTC'), 'YYYY-MM-DD')`;

async function courseActivities(tx: DB, courseId: string) {
  const rows = await tx
    .select({ id: activities.id, name: activities.name, type: activities.type, completionRule: activities.completionRule })
    .from(activities)
    .innerJoin(courseSections, eq(courseSections.id, activities.sectionId))
    .where(eq(activities.courseId, courseId))
    .orderBy(asc(courseSections.position), asc(activities.position));
  return rows;
}

/** Per-user count + last time of one event for one activity. */
async function eventStats(tx: DB, input: { courseId: string; activityId: string; eventName: string; userIds: string[] }) {
  if (!input.userIds.length) return new Map<string, { n: number; last: Date | null }>();
  const rows = await tx
    .select({ userId: eventLog.userId, n: count(), last: max(eventLog.createdAt) })
    .from(eventLog)
    .where(
      and(
        eq(eventLog.courseId, input.courseId),
        eq(eventLog.activityId, input.activityId),
        eq(eventLog.eventName, input.eventName),
        inArray(eventLog.userId, input.userIds),
      ),
    )
    .groupBy(eventLog.userId);
  return new Map(rows.map((r) => [r.userId!, { n: Number(r.n), last: r.last ? new Date(r.last) : null }]));
}

export const routes: FastifyPluginAsyncZod = async (app) => {
  // ─── Course reports ─────────────────────────────────────────────────────

  app.get(
    "/courses/:courseId/overview",
    {
      schema: {
        tags: ["Reports"],
        summary: "Course activity overview: views per activity, active users per day (30 days)",
        params: courseIdParam,
        response: {
          200: z.object({
            learners: z.number().int(),
            completions: z.number().int(),
            views30d: z.number().int(),
            activeUsersByDay: zSeries,
            activities: z.array(zActivityRef.extend({ views: z.number().int(), viewers: z.number().int(), completed: z.number().int() })),
          }),
        },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const course = await loadCourseWith(tx, req, req.params.courseId, "report:view_course");
        const since = windowStart(30);
        const [acts, learners, views, perDay, completed, [done]] = await Promise.all([
          courseActivities(tx, course.id),
          gradebookUsers(tx, course),
          tx
            .select({ activityId: eventLog.activityId, views: count(), viewers: countDistinct(eventLog.userId) })
            .from(eventLog)
            .where(and(eq(eventLog.courseId, course.id), eq(eventLog.eventName, "activity.viewed")))
            .groupBy(eventLog.activityId),
          tx
            .select({ date: dayExpr, value: countDistinct(eventLog.userId) })
            .from(eventLog)
            .where(and(eq(eventLog.courseId, course.id), gte(eventLog.createdAt, since)))
            .groupBy(dayExpr),
          tx
            .select({ activityId: activityCompletions.activityId, n: count() })
            .from(activityCompletions)
            .innerJoin(activities, eq(activities.id, activityCompletions.activityId))
            .where(and(eq(activities.courseId, course.id), inArray(activityCompletions.state, ["complete", "complete_pass"])))
            .groupBy(activityCompletions.activityId),
          tx.select({ n: count() }).from(courseCompletions).where(eq(courseCompletions.courseId, course.id)),
        ]);
        const [recent] = await tx
          .select({ n: count() })
          .from(eventLog)
          .where(and(eq(eventLog.courseId, course.id), eq(eventLog.eventName, "activity.viewed"), gte(eventLog.createdAt, since)));
        const viewsOf = new Map(views.map((v) => [v.activityId, v]));
        const completedOf = new Map(completed.map((c) => [c.activityId, Number(c.n)]));
        return {
          learners: learners.length,
          completions: Number(done?.n ?? 0),
          views30d: Number(recent?.n ?? 0),
          activeUsersByDay: fillDays(perDay.map((r) => ({ date: r.date, value: Number(r.value) })), 30),
          activities: acts.map((a) => ({
            id: a.id,
            name: a.name,
            type: a.type,
            views: Number(viewsOf.get(a.id)?.views ?? 0),
            viewers: Number(viewsOf.get(a.id)?.viewers ?? 0),
            completed: completedOf.get(a.id) ?? 0,
          })),
        };
      }),
  );

  app.get(
    "/courses/:courseId/participation",
    {
      schema: {
        tags: ["Reports"],
        summary: "Participation in one activity: which learners viewed / submitted it",
        params: courseIdParam,
        querystring: zPagination.extend({ activityId: zId.optional() }),
        response: {
          200: paged(
            z.object({
              user: zUserSummary,
              views: z.number().int(),
              lastViewedAt: zNullableDate,
              submissions: z.number().int(),
              lastSubmittedAt: zNullableDate,
              completion: z.string().nullable(),
            }),
          ).extend({ activities: z.array(zActivityRef), activityId: zId.nullable() }),
        },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const course = await loadCourseWith(tx, req, req.params.courseId, "report:view_course");
        const q = req.query;
        const acts = await courseActivities(tx, course.id);
        const refs = acts.map(({ id, name, type }) => ({ id, name, type }));
        const activity = q.activityId ? acts.find((a) => a.id === q.activityId) : acts[0];
        if (q.activityId && !activity) throw notFound("Activity");
        if (!activity) return { activities: refs, activityId: null, items: [], total: 0, page: q.page, pageSize: q.pageSize };

        const learners = await gradebookUsers(tx, course);
        const page = learners.slice(offset(q), offset(q) + q.pageSize);
        const ids = page.map((u) => u.id);
        const [viewed, submitted, completion] = await Promise.all([
          eventStats(tx, { courseId: course.id, activityId: activity.id, eventName: "activity.viewed", userIds: ids }),
          eventStats(tx, { courseId: course.id, activityId: activity.id, eventName: "activity.submitted", userIds: ids }),
          ids.length
            ? tx
                .select({ userId: activityCompletions.userId, state: activityCompletions.state })
                .from(activityCompletions)
                .where(and(eq(activityCompletions.activityId, activity.id), inArray(activityCompletions.userId, ids)))
            : Promise.resolve([] as { userId: string; state: string }[]),
        ]);
        const stateOf = new Map(completion.map((c) => [c.userId, c.state]));
        return {
          activities: refs,
          activityId: activity.id,
          items: page.map((u) => ({
            user: { id: u.id, firstName: u.firstName, lastName: u.lastName },
            views: viewed.get(u.id)?.n ?? 0,
            lastViewedAt: viewed.get(u.id)?.last ?? null,
            submissions: submitted.get(u.id)?.n ?? 0,
            lastSubmittedAt: submitted.get(u.id)?.last ?? null,
            completion: activity.completionRule === "none" ? null : (stateOf.get(u.id) ?? "incomplete"),
          })),
          total: learners.length,
          page: q.page,
          pageSize: q.pageSize,
        };
      }),
  );

  app.get(
    "/courses/:courseId/users/:userId/outline",
    {
      schema: {
        tags: ["Reports"],
        summary: "Outline report of one user in a course (own, or with report:view_course)",
        params: courseIdParam.extend({ userId: zId }),
        response: {
          200: z.object({
            user: zUserSummary,
            activities: z.array(
              zActivityRef.extend({
                views: z.number().int(),
                lastViewedAt: zNullableDate,
                completion: z.string().nullable(),
                grade: z.number().nullable(),
                gradeMax: z.number().nullable(),
              }),
            ),
          }),
        },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const me = requireUser(req);
        const course = await loadCourse(tx, req, req.params.courseId);
        const userId = req.params.userId;
        // IDOR: other users' outlines need report:view_course.
        const canViewAll = await hasCapability(tx, req, "report:view_course", course.contextId);
        if (userId !== me.id && !canViewAll) throw notFound("User");
        const [user] = await tx
          .select({ id: users.id, firstName: users.firstName, lastName: users.lastName })
          .from(enrolments)
          .innerJoin(users, eq(users.id, enrolments.userId))
          .where(and(eq(enrolments.courseId, course.id), eq(enrolments.userId, userId)))
          .limit(1);
        if (!user) throw notFound("User");

        const seeHidden = await hasCapability(tx, req, "course:view_hidden", course.contextId);
        const acts = (
          await tx
            .select({ a: activities, sectionVisible: courseSections.visible })
            .from(activities)
            .innerJoin(courseSections, eq(courseSections.id, activities.sectionId))
            .where(eq(activities.courseId, course.id))
            .orderBy(asc(courseSections.position), asc(activities.position))
        )
          .filter((r) => seeHidden || (r.a.visible && r.sectionVisible))
          .map((r) => r.a);
        const ids = acts.map((a) => a.id);
        const [views, states, grades] = ids.length
          ? await Promise.all([
              tx
                .select({ activityId: eventLog.activityId, n: count(), last: max(eventLog.createdAt) })
                .from(eventLog)
                .where(and(eq(eventLog.courseId, course.id), eq(eventLog.userId, userId), eq(eventLog.eventName, "activity.viewed")))
                .groupBy(eventLog.activityId),
              tx
                .select({ activityId: activityCompletions.activityId, state: activityCompletions.state })
                .from(activityCompletions)
                .where(and(eq(activityCompletions.userId, userId), inArray(activityCompletions.activityId, ids))),
              tx
                .select({ activityId: gradeItems.activityId, hidden: gradeItems.hidden, gradeMax: gradeItems.gradeMax, grade: gradeGrades.finalGrade })
                .from(gradeItems)
                .leftJoin(gradeGrades, and(eq(gradeGrades.itemId, gradeItems.id), eq(gradeGrades.userId, userId)))
                .where(and(eq(gradeItems.courseId, course.id), inArray(gradeItems.activityId, ids))),
            ])
          : [[], [], []];
        const canSeeGrades = canViewAll
          ? await hasCapability(tx, req, "grades:view_all", course.contextId)
          : await hasCapability(tx, req, "grades:view_own", course.contextId);
        const viewOf = new Map(views.map((v) => [v.activityId, v]));
        const stateOf = new Map(states.map((s) => [s.activityId, s.state]));
        const gradeOf = new Map(grades.map((g) => [g.activityId, g]));
        return {
          user,
          activities: acts.map((a) => {
            const g = gradeOf.get(a.id);
            const showGrade = !!g && canSeeGrades && (canViewAll || !g.hidden);
            return {
              id: a.id,
              name: a.name,
              type: a.type,
              views: Number(viewOf.get(a.id)?.n ?? 0),
              lastViewedAt: viewOf.get(a.id)?.last ? new Date(viewOf.get(a.id)!.last!) : null,
              completion: a.completionRule === "none" ? null : (stateOf.get(a.id) ?? "incomplete"),
              grade: showGrade ? (g.grade ?? null) : null,
              gradeMax: showGrade ? g.gradeMax : null,
            };
          }),
        };
      }),
  );

  app.get(
    "/courses/:courseId/logs",
    {
      schema: {
        tags: ["Reports"],
        summary: "Course event log (newest first)",
        params: courseIdParam,
        querystring: zPagination.extend({
          userId: zId.optional(),
          activityId: zId.optional(),
          eventName: z.string().max(100).optional(),
        }),
        response: {
          200: paged(
            z.object({
              id: zId,
              eventName: z.string(),
              createdAt: zDate,
              user: zUserSummary.nullable(),
              activity: z.object({ id: zId, name: z.string() }).nullable(),
            }),
          ).extend({ eventNames: z.array(z.string()) }),
        },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const course = await loadCourseWith(tx, req, req.params.courseId, "report:view_course");
        const q = req.query;
        const where = and(
          eq(eventLog.courseId, course.id),
          q.userId ? eq(eventLog.userId, q.userId) : undefined,
          q.activityId ? eq(eventLog.activityId, q.activityId) : undefined,
          q.eventName ? eq(eventLog.eventName, q.eventName) : undefined,
        );
        const [rows, [{ total }], names] = (await Promise.all([
          tx
            .select({
              id: eventLog.id,
              eventName: eventLog.eventName,
              createdAt: eventLog.createdAt,
              userId: users.id,
              firstName: users.firstName,
              lastName: users.lastName,
              activityId: activities.id,
              activityName: activities.name,
            })
            .from(eventLog)
            .leftJoin(users, eq(users.id, eventLog.userId))
            .leftJoin(activities, eq(activities.id, eventLog.activityId))
            .where(where)
            .orderBy(desc(eventLog.createdAt))
            .limit(q.pageSize)
            .offset(offset(q)),
          tx.select({ total: count() }).from(eventLog).where(where),
          tx.selectDistinct({ name: eventLog.eventName }).from(eventLog).where(eq(eventLog.courseId, course.id)).orderBy(asc(eventLog.eventName)),
        ])) as [
          { id: string; eventName: string; createdAt: Date; userId: string | null; firstName: string | null; lastName: string | null; activityId: string | null; activityName: string | null }[],
          [{ total: number }],
          { name: string }[],
        ];
        return {
          items: rows.map((r) => ({
            id: r.id,
            eventName: r.eventName,
            createdAt: r.createdAt,
            user: r.userId ? { id: r.userId, firstName: r.firstName ?? "", lastName: r.lastName ?? "" } : null,
            activity: r.activityId ? { id: r.activityId, name: r.activityName ?? "" } : null,
          })),
          total: Number(total),
          page: q.page,
          pageSize: q.pageSize,
          eventNames: names.map((n) => n.name),
        };
      }),
  );

  // ─── Site report ────────────────────────────────────────────────────────

  app.get(
    "/site",
    {
      schema: {
        tags: ["Reports"],
        summary: "Site overview: users, activity, courses, enrolments, completions",
        response: {
          200: z.object({
            users: z.number().int(),
            newUsers30d: z.number().int(),
            activeUsers7d: z.number().int(),
            activeUsers30d: z.number().int(),
            courses: z.number().int(),
            visibleCourses: z.number().int(),
            enrolments: z.number().int(),
            completions: z.number().int(),
            completions30d: z.number().int(),
            activeUsersByDay: zSeries,
            topCourses: z.array(z.object({ id: zId, fullname: z.string(), shortname: z.string(), enrolments: z.number().int(), completions: z.number().int() })),
          }),
        },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        requireUser(req);
        const system = await getSystemContext(tx, req.org.id);
        await requireCapability(tx, req, "report:view_site", system.id);
        const now = Date.now();
        const d7 = new Date(now - 7 * DAY);
        const d30 = new Date(now - 30 * DAY);
        const alive = isNull(users.deletedAt);
        const one = async (q: Promise<{ n: number }[]>) => Number((await q)[0]?.n ?? 0);
        const [userCount, newUsers, active7, active30, courseCount, visibleCount, enrolCount, completionCount, completions30, perDay, top] = await Promise.all([
          one(tx.select({ n: count() }).from(users).where(alive)),
          one(tx.select({ n: count() }).from(users).where(and(alive, gte(users.createdAt, d30)))),
          one(tx.select({ n: count() }).from(users).where(and(alive, gte(users.lastLoginAt, d7)))),
          one(tx.select({ n: count() }).from(users).where(and(alive, gte(users.lastLoginAt, d30)))),
          one(tx.select({ n: count() }).from(courses)),
          one(tx.select({ n: count() }).from(courses).where(eq(courses.visible, true))),
          one(tx.select({ n: count() }).from(enrolments).where(eq(enrolments.status, "active"))),
          one(tx.select({ n: count() }).from(courseCompletions)),
          one(tx.select({ n: count() }).from(courseCompletions).where(gte(courseCompletions.completedAt, d30))),
          tx
            .select({ date: dayExpr, value: countDistinct(eventLog.userId) })
            .from(eventLog)
            .where(gte(eventLog.createdAt, windowStart(30)))
            .groupBy(dayExpr),
          tx
            .select({ id: courses.id, fullname: courses.fullname, shortname: courses.shortname, n: count() })
            .from(enrolments)
            .innerJoin(courses, eq(courses.id, enrolments.courseId))
            .where(eq(enrolments.status, "active"))
            .groupBy(courses.id, courses.fullname, courses.shortname)
            .orderBy(desc(count()))
            .limit(10),
        ]);
        const topIds = top.map((t) => t.id);
        const doneRows = topIds.length
          ? await tx
              .select({ courseId: courseCompletions.courseId, n: count() })
              .from(courseCompletions)
              .where(inArray(courseCompletions.courseId, topIds))
              .groupBy(courseCompletions.courseId)
          : [];
        const doneOf = new Map(doneRows.map((d) => [d.courseId, Number(d.n)]));
        return {
          users: userCount,
          newUsers30d: newUsers,
          activeUsers7d: active7,
          activeUsers30d: active30,
          courses: courseCount,
          visibleCourses: visibleCount,
          enrolments: enrolCount,
          completions: completionCount,
          completions30d: completions30,
          activeUsersByDay: fillDays(perDay.map((r) => ({ date: r.date, value: Number(r.value) })), 30),
          topCourses: top.map((t) => ({ id: t.id, fullname: t.fullname, shortname: t.shortname, enrolments: Number(t.n), completions: doneOf.get(t.id) ?? 0 })),
        };
      }),
  );
};
