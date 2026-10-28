import { and, asc, eq, inArray } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { attendanceRecords, attendanceSessions, attendances, calendarEvents, groupMembers, groups, type DB } from "@lms/db";
import { z } from "zod";
import { registerActivityType, type ActivityRow } from "../../core/activity-types";
import { requireUser } from "../../core/auth";
import { on, type EventMap } from "../../core/events";
import { must } from "../../core/errors";
import { hasCapability } from "../../core/rbac";
import { activityById, loadActivity } from "../activities/service";
import { pushGrade } from "../gradebook/service";
import { computeAttendance, type AttendanceStatus } from "./logic";

export type AttendanceRow = typeof attendances.$inferSelect;
export type SessionRow = typeof attendanceSessions.$inferSelect;

const zPoints = z.number().min(0).max(100);
export const attendanceSettings = z.object({
  gradeMax: z.number().min(0).max(1000).default(100),
  statusPoints: z
    .object({ present: zPoints, late: zPoints, excused: zPoints, absent: zPoints })
    .default({ present: 2, late: 1, excused: 1, absent: 0 }),
  allowSelfMarking: z.boolean().default(false),
});

export async function attendanceOf(tx: DB, activityId: string) {
  return must((await tx.select().from(attendances).where(eq(attendances.activityId, activityId)).limit(1))[0], "Attendance");
}

export function registerAttendance() {
  registerActivityType({
    type: "attendance",
    label: "Attendance",
    settings: attendanceSettings,
    async create(tx, ctx, s) {
      await tx.insert(attendances).values({
        organizationId: ctx.organizationId,
        activityId: ctx.activity.id,
        gradeMax: s.gradeMax,
        statusPoints: s.statusPoints,
        allowSelfMarking: s.allowSelfMarking,
      });
    },
    async update(tx, ctx, s) {
      const att = await attendanceOf(tx, ctx.activity.id);
      const patch: Partial<typeof attendances.$inferInsert> = {};
      if (s.gradeMax !== undefined) patch.gradeMax = s.gradeMax;
      if (s.statusPoints !== undefined) patch.statusPoints = s.statusPoints;
      if (s.allowSelfMarking !== undefined) patch.allowSelfMarking = s.allowSelfMarking;
      if (Object.keys(patch).length) await tx.update(attendances).set(patch).where(eq(attendances.id, att.id));
    },
    async load(tx, activity) {
      const [a] = await tx.select().from(attendances).where(eq(attendances.activityId, activity.id)).limit(1);
      if (!a) return null;
      return { gradeMax: a.gradeMax, statusPoints: a.statusPoints, allowSelfMarking: a.allowSelfMarking };
    },
    async grading(tx, activity) {
      const [a] = await tx.select({ gradeMax: attendances.gradeMax }).from(attendances).where(eq(attendances.activityId, activity.id)).limit(1);
      return { gradeMax: a?.gradeMax ?? 100, gradePass: null };
    },
  });

  // Session calendar entries share the session's id; clean them up with the activity.
  on("activity.deleted", async (tx, p) => {
    if (p.type !== "attendance") return;
    await tx.delete(calendarEvents).where(and(eq(calendarEvents.activityId, p.activityId), eq(calendarEvents.type, "session")));
  });
  on("activity.updated", async (tx, p) => {
    if (p.type !== "attendance") return;
    const activity = await activityById(tx, p.activityId);
    await tx
      .update(calendarEvents)
      .set({ name: activity.name })
      .where(and(eq(calendarEvents.activityId, p.activityId), eq(calendarEvents.type, "session")));
  });
}

export async function loadAttendance(tx: DB, req: FastifyRequest, activityId: string) {
  const me = requireUser(req);
  const { activity, course } = await loadActivity(tx, req, activityId, { type: "attendance" });
  const attendance = await attendanceOf(tx, activity.id);
  const canTake = await hasCapability(tx, req, "attendance:take", activity.contextId);
  const canViewAll = canTake || (await hasCapability(tx, req, "attendance:view_all", activity.contextId));
  const canSelfMark = await hasCapability(tx, req, "attendance:self_mark", activity.contextId);
  return { me, activity, course, attendance, canTake, canViewAll, canSelfMark };
}
export type AttendanceCtx = Awaited<ReturnType<typeof loadAttendance>>;

export async function sessionsOf(tx: DB, attendanceId: string) {
  return tx
    .select({ s: attendanceSessions, groupName: groups.name })
    .from(attendanceSessions)
    .leftJoin(groups, eq(groups.id, attendanceSessions.groupId))
    .where(eq(attendanceSessions.attendanceId, attendanceId))
    .orderBy(asc(attendanceSessions.startsAt));
}

/** Group ids per user (only course groups). */
export async function groupMap(tx: DB, courseId: string, userIds: string[]) {
  const out = new Map<string, Set<string>>(userIds.map((id) => [id, new Set()]));
  if (!userIds.length) return out;
  const rows = await tx
    .select({ userId: groupMembers.userId, groupId: groupMembers.groupId })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .where(and(eq(groups.courseId, courseId), inArray(groupMembers.userId, userIds)));
  for (const r of rows) out.get(r.userId)?.add(r.groupId);
  return out;
}

export const appliesTo = (session: Pick<SessionRow, "groupId">, userGroups: Set<string> | undefined) =>
  session.groupId === null || !!userGroups?.has(session.groupId);

/**
 * Attendance summary per user over the sessions that apply to them.
 * `sessions` and `records` should cover the whole activity.
 */
export function summarize(
  attendance: AttendanceRow,
  sessions: SessionRow[],
  records: { sessionId: string; userId: string; status: AttendanceStatus }[],
  userId: string,
  userGroups: Set<string> | undefined,
) {
  const mine = new Map(records.filter((r) => r.userId === userId).map((r) => [r.sessionId, r.status]));
  return computeAttendance({
    sessions: sessions.filter((s) => appliesTo(s, userGroups)).map((s) => ({ id: s.id, taken: s.takenAt !== null })),
    records: mine,
    statusPoints: attendance.statusPoints,
    gradeMax: attendance.gradeMax,
  });
}

/**
 * Recomputes and pushes the attendance grade of the given users. Returns the
 * grade.updated payloads for the caller to emit after commit.
 */
export async function recomputeGrades(
  tx: DB,
  input: { activity: ActivityRow; course: { id: string }; attendance: AttendanceRow; userIds: string[]; gradedBy: string | null },
) {
  const userIds = [...new Set(input.userIds)];
  if (!userIds.length) return [];
  const sessions = (await sessionsOf(tx, input.attendance.id)).map((r) => r.s);
  const records = sessions.length
    ? await tx
        .select({ sessionId: attendanceRecords.sessionId, userId: attendanceRecords.userId, status: attendanceRecords.status })
        .from(attendanceRecords)
        .where(and(inArray(attendanceRecords.sessionId, sessions.map((s) => s.id)), inArray(attendanceRecords.userId, userIds)))
    : [];
  const groupsOf = await groupMap(tx, input.course.id, userIds);
  const payloads: EventMap["grade.updated"][] = [];
  for (const userId of userIds) {
    const summary = summarize(input.attendance, sessions, records, userId, groupsOf.get(userId));
    const payload = await pushGrade(tx, {
      organizationId: input.activity.organizationId,
      activityId: input.activity.id,
      userId,
      rawGrade: summary.grade,
      gradedBy: input.gradedBy,
      source: "attendance",
    });
    if (payload) payloads.push(payload);
  }
  return payloads;
}

/** Mirrors a session into calendar_events (same id) so the calendar module shows it. */
export async function syncCalendarEvent(tx: DB, activity: ActivityRow, session: SessionRow, createdBy: string | null) {
  const values = {
    name: activity.name,
    description: session.description,
    startsAt: session.startsAt,
    durationMinutes: session.durationMinutes,
  };
  await tx
    .insert(calendarEvents)
    .values({ ...values, id: session.id, organizationId: activity.organizationId, type: "session", courseId: activity.courseId, activityId: activity.id, createdBy })
    .onConflictDoUpdate({ target: calendarEvents.id, set: values });
}

export async function deleteCalendarEvent(tx: DB, sessionId: string) {
  await tx.delete(calendarEvents).where(and(eq(calendarEvents.id, sessionId), eq(calendarEvents.type, "session")));
}
