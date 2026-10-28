import { and, asc, eq, gte, inArray, isNotNull, lt, or } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { activities, calendarEvents, courseSections, courses, enrolments, getSystemContext, type DB } from "@lms/db";
import { requireUser } from "../../core/auth";
import { forbidden, notFound } from "../../core/errors";
import { hasCapability, requireCapability } from "../../core/rbac";
import { loadCourse } from "../courses/service";

export type CalendarEventRow = typeof calendarEvents.$inferSelect;
export type CalendarItemType = CalendarEventRow["type"];

export type CalendarItem = {
  /** Stored events: their uuid. Derived activity deadlines: "due:<activityId>". */
  id: string;
  type: CalendarItemType;
  name: string;
  description: string | null;
  startsAt: Date;
  durationMinutes: number;
  courseId: string | null;
  courseName: string | null;
  activityId: string | null;
  link: string | null;
  editable: boolean;
};

/** Longest event we look back for when it started before the window (multi-day events). */
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/** Courses whose calendar the user sees: active enrolments in courses they may view. */
async function visibleCourses(tx: DB, req: FastifyRequest, userId: string) {
  const rows = await tx
    .select({ course: courses })
    .from(enrolments)
    .innerJoin(courses, eq(courses.id, enrolments.courseId))
    .where(and(eq(enrolments.userId, userId), eq(enrolments.status, "active")));
  const out: { course: typeof courses.$inferSelect; seeHidden: boolean }[] = [];
  for (const { course } of rows) {
    if (!(await hasCapability(tx, req, "course:view", course.contextId))) continue;
    const seeHidden = await hasCapability(tx, req, "course:view_hidden", course.contextId);
    if (!course.visible && !seeHidden) continue;
    out.push({ course, seeHidden });
  }
  return out;
}

/**
 * Everything on the user's calendar in [from, to): site events, events of their courses (course /
 * due / session), their own user events, and activity deadlines (availableUntil) of activities they
 * can see. Optionally restricted to one course.
 */
export async function calendarItems(
  tx: DB,
  req: FastifyRequest,
  range: { from: Date; to: Date; courseId?: string },
): Promise<CalendarItem[]> {
  const me = requireUser(req);
  let scope: { course: typeof courses.$inferSelect; seeHidden: boolean }[];
  if (range.courseId) {
    const course = await loadCourse(tx, req, range.courseId);
    scope = [{ course, seeHidden: await hasCapability(tx, req, "course:view_hidden", course.contextId) }];
  } else {
    scope = await visibleCourses(tx, req, me.id);
  }
  const courseOf = new Map(scope.map((s) => [s.course.id, s]));
  const courseIds = [...courseOf.keys()];

  const system = await getSystemContext(tx, req.org.id);
  const canManageSite = await hasCapability(tx, req, "calendar:manage_site", system.id);
  const manageCourse = new Map<string, boolean>();
  for (const s of scope) manageCourse.set(s.course.id, await hasCapability(tx, req, "calendar:manage_course", s.course.contextId));

  const ownership = range.courseId
    ? and(eq(calendarEvents.courseId, range.courseId), inArray(calendarEvents.type, ["course", "due", "session"]))
    : or(
        eq(calendarEvents.type, "site"),
        and(eq(calendarEvents.type, "user"), eq(calendarEvents.userId, me.id)),
        courseIds.length ? and(inArray(calendarEvents.courseId, courseIds), inArray(calendarEvents.type, ["course", "due", "session"])) : undefined,
      );
  const stored = await tx
    .select()
    .from(calendarEvents)
    .where(and(ownership, gte(calendarEvents.startsAt, new Date(range.from.getTime() - LOOKBACK_MS)), lt(calendarEvents.startsAt, range.to)))
    .orderBy(asc(calendarEvents.startsAt));

  const items: CalendarItem[] = [];
  const storedDue = new Set<string>();
  for (const e of stored) {
    const end = e.startsAt.getTime() + e.durationMinutes * 60_000;
    if (e.startsAt < range.from && end <= range.from.getTime()) continue;
    if (e.activityId) storedDue.add(e.activityId);
    const course = e.courseId ? courseOf.get(e.courseId)?.course : undefined;
    items.push({
      id: e.id,
      type: e.type,
      name: e.name,
      description: e.description,
      startsAt: e.startsAt,
      durationMinutes: e.durationMinutes,
      courseId: e.courseId,
      courseName: course?.fullname ?? null,
      activityId: e.activityId,
      link: e.activityId ? `/activities/${e.activityId}` : e.courseId ? `/courses/${e.courseId}` : null,
      editable:
        e.type === "user" ? e.userId === me.id : e.type === "site" ? canManageSite : e.type === "course" ? !!(e.courseId && manageCourse.get(e.courseId)) : false,
    });
  }

  if (courseIds.length) {
    const due = await tx
      .select({ a: activities, sectionVisible: courseSections.visible })
      .from(activities)
      .innerJoin(courseSections, eq(courseSections.id, activities.sectionId))
      .where(
        and(
          inArray(activities.courseId, courseIds),
          isNotNull(activities.availableUntil),
          gte(activities.availableUntil, range.from),
          lt(activities.availableUntil, range.to),
        ),
      );
    for (const { a, sectionVisible } of due) {
      const s = courseOf.get(a.courseId)!;
      if ((!a.visible || !sectionVisible) && !s.seeHidden) continue;
      if (storedDue.has(a.id)) continue;
      items.push({
        id: `due:${a.id}`,
        type: "due",
        name: `${a.name} is due`,
        description: null,
        startsAt: a.availableUntil!,
        durationMinutes: 0,
        courseId: a.courseId,
        courseName: s.course.fullname,
        activityId: a.id,
        link: `/activities/${a.id}`,
        editable: false,
      });
    }
  }
  return items.sort((x, y) => x.startsAt.getTime() - y.startsAt.getTime() || x.name.localeCompare(y.name));
}

/**
 * Checks the caller may create/edit/delete an event of this type.
 * Site: calendar:manage_site (system). Course: calendar:manage_course (course). User: own events only.
 * due/session events belong to activity modules and are not editable here.
 */
export async function assertCanManage(
  tx: DB,
  req: FastifyRequest,
  event: { type: CalendarItemType; courseId: string | null; userId: string | null },
) {
  const me = requireUser(req);
  switch (event.type) {
    case "site": {
      const system = await getSystemContext(tx, req.org.id);
      await requireCapability(tx, req, "calendar:manage_site", system.id);
      return;
    }
    case "course": {
      if (!event.courseId) throw notFound("Course");
      const [course] = await tx.select().from(courses).where(eq(courses.id, event.courseId)).limit(1);
      if (!course) throw notFound("Course");
      await requireCapability(tx, req, "calendar:manage_course", course.contextId);
      return;
    }
    case "user":
      if (event.userId !== me.id) throw notFound("Event");
      return;
    default:
      throw forbidden("This event is managed by its activity");
  }
}

/** Courses in which the user may add course events. */
export async function manageableCourses(tx: DB, req: FastifyRequest) {
  const me = requireUser(req);
  const out: { id: string; fullname: string }[] = [];
  for (const { course } of await visibleCourses(tx, req, me.id)) {
    if (await hasCapability(tx, req, "calendar:manage_course", course.contextId)) out.push({ id: course.id, fullname: course.fullname });
  }
  return out.sort((a, b) => a.fullname.localeCompare(b.fullname));
}
