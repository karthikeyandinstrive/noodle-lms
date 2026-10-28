import { and, eq, inArray } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { attendanceRecords, attendanceSessions, type DB } from "@lms/db";
import { z } from "zod";
import { audit } from "../../core/audit";
import { AppError, badRequest, conflict, forbidden, notFound } from "../../core/errors";
import { emit, type EventMap } from "../../core/events";
import { requireCapability } from "../../core/rbac";
import { safeEqual, sha256 } from "../../core/crypto";
import { ok, zDate, zDateInput, zId, zNullableDate, zOk } from "../../core/schemas";
import { courseGroups, groupInCourse, learnerIds, userSummaries } from "../forum/people";
import { STATUSES, toCsv, weeklyOccurrences, withinSession, type AttendanceStatus } from "./logic";
import {
  appliesTo,
  deleteCalendarEvent,
  groupMap,
  loadAttendance,
  recomputeGrades,
  sessionsOf,
  summarize,
  syncCalendarEvent,
  type AttendanceCtx,
  type SessionRow,
} from "./service";

const tags = ["Attendance"];
const params = z.object({ activityId: zId });
const sessionParams = params.extend({ sessionId: zId });
const zStatus = z.enum(STATUSES);
const zPerson = z.object({ id: zId, firstName: z.string(), lastName: z.string() });
const zPoints = z.object({ present: z.number(), late: z.number(), excused: z.number(), absent: z.number() });

const zSummary = z.object({
  sessions: z.number().int(),
  counts: z.object({ present: z.number().int(), late: z.number().int(), excused: z.number().int(), absent: z.number().int() }),
  earned: z.number(),
  max: z.number(),
  percentage: z.number().nullable(),
  grade: z.number().nullable(),
});

const zSession = z.object({
  id: zId,
  startsAt: zDate,
  durationMinutes: z.number().int(),
  description: z.string().nullable(),
  groupId: zId.nullable(),
  groupName: z.string().nullable(),
  hasCode: z.boolean(),
  takenAt: zNullableDate,
  /** Current user's status (learners). */
  myStatus: zStatus.nullable(),
  /** The current user can self-mark this session right now. */
  selfMarkOpen: z.boolean(),
  /** Number of records (staff only; 0 otherwise). */
  recorded: z.number().int(),
});

/** Code entered by learners; stored only as a SHA-256 hash. */
const zCode = z.string().trim().min(4).max(32);
const zSessionInput = z.object({
  startsAt: zDateInput,
  durationMinutes: z.number().int().min(5).max(24 * 60).default(60),
  description: z.string().trim().max(1000).nullable().optional(),
  groupId: zId.nullable().optional(),
  selfMarkCode: zCode.nullable().optional(),
});

const normalizeCode = (code: string) => sha256(code.trim().toUpperCase());

async function loadSession(tx: DB, ctx: AttendanceCtx, sessionId: string) {
  const [s] = await tx
    .select()
    .from(attendanceSessions)
    .where(and(eq(attendanceSessions.id, sessionId), eq(attendanceSessions.attendanceId, ctx.attendance.id)))
    .limit(1);
  if (!s) throw notFound("Session");
  return s;
}

/** Learners a session applies to (group sessions: that group's members). */
async function eligibleLearners(tx: DB, ctx: AttendanceCtx, session: Pick<SessionRow, "groupId">) {
  const learners = await learnerIds(tx, ctx.course);
  if (!session.groupId) return learners;
  const groupsOf = await groupMap(tx, ctx.course.id, learners);
  return learners.filter((id) => groupsOf.get(id)?.has(session.groupId!));
}

function requireTake(ctx: AttendanceCtx) {
  if (!ctx.canTake) throw forbidden("Missing capability attendance:take");
}

function requireViewAll(ctx: AttendanceCtx) {
  if (!ctx.canViewAll) throw forbidden("Missing capability attendance:view_all");
}

/** Full report: every learner × every applicable session. */
async function buildReport(tx: DB, ctx: AttendanceCtx) {
  const sessionRows = await sessionsOf(tx, ctx.attendance.id);
  const sessions = sessionRows.map((r) => r.s);
  const learners = await learnerIds(tx, ctx.course);
  const records = sessions.length
    ? await tx
        .select({ sessionId: attendanceRecords.sessionId, userId: attendanceRecords.userId, status: attendanceRecords.status })
        .from(attendanceRecords)
        .where(inArray(attendanceRecords.sessionId, sessions.map((s) => s.id)))
    : [];
  // Include anyone with records (e.g. since unenrolled) so history isn't lost.
  const userIds = [...new Set([...learners, ...records.map((r) => r.userId)])];
  const people = await userSummaries(tx, userIds);
  const groupsOf = await groupMap(tx, ctx.course.id, userIds);
  const rows = userIds
    .map((id) => {
      const g = groupsOf.get(id);
      const statuses: Record<string, AttendanceStatus | null> = {};
      for (const s of sessions) {
        if (!appliesTo(s, g)) continue;
        statuses[s.id] = records.find((r) => r.sessionId === s.id && r.userId === id)?.status ?? null;
      }
      return {
        user: people.get(id) ?? { id, firstName: "Unknown", lastName: "user" },
        statuses,
        summary: summarize(ctx.attendance, sessions, records, id, g),
      };
    })
    .sort((a, b) => a.user.lastName.localeCompare(b.user.lastName) || a.user.firstName.localeCompare(b.user.firstName));
  return { sessionRows, rows };
}

export const routes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/:activityId",
    {
      schema: {
        tags,
        summary: "Attendance settings, my permissions and my summary",
        params,
        response: {
          200: z.object({
            gradeMax: z.number(),
            statusPoints: zPoints,
            allowSelfMarking: z.boolean(),
            canTake: z.boolean(),
            canViewAll: z.boolean(),
            canSelfMark: z.boolean(),
            groups: z.array(z.object({ id: zId, name: z.string() })),
            mySummary: zSummary.nullable(),
          }),
        },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const ctx = await loadAttendance(tx, req, req.params.activityId);
        let mySummary = null;
        if (!ctx.canTake) {
          const sessions = (await sessionsOf(tx, ctx.attendance.id)).map((r) => r.s);
          const records = sessions.length
            ? await tx
                .select({ sessionId: attendanceRecords.sessionId, userId: attendanceRecords.userId, status: attendanceRecords.status })
                .from(attendanceRecords)
                .where(and(inArray(attendanceRecords.sessionId, sessions.map((s) => s.id)), eq(attendanceRecords.userId, ctx.me.id)))
            : [];
          const g = (await groupMap(tx, ctx.course.id, [ctx.me.id])).get(ctx.me.id);
          mySummary = summarize(ctx.attendance, sessions, records, ctx.me.id, g);
        }
        return {
          gradeMax: ctx.attendance.gradeMax,
          statusPoints: ctx.attendance.statusPoints,
          allowSelfMarking: ctx.attendance.allowSelfMarking,
          canTake: ctx.canTake,
          canViewAll: ctx.canViewAll,
          canSelfMark: ctx.canSelfMark && ctx.attendance.allowSelfMarking,
          groups: ctx.canTake ? await courseGroups(tx, ctx.course.id) : [],
          mySummary,
        };
      }),
  );

  app.get(
    "/:activityId/sessions",
    { schema: { tags, summary: "Sessions (learners: only sessions that apply to them, with their status)", params, response: { 200: z.array(zSession) } } },
    (req) =>
      req.tenant(async (tx) => {
        const ctx = await loadAttendance(tx, req, req.params.activityId);
        const rows = await sessionsOf(tx, ctx.attendance.id);
        const ids = rows.map((r) => r.s.id);
        const all = ids.length
          ? await tx.select({ sessionId: attendanceRecords.sessionId, userId: attendanceRecords.userId, status: attendanceRecords.status }).from(attendanceRecords).where(inArray(attendanceRecords.sessionId, ids))
          : [];
        const myGroups = (await groupMap(tx, ctx.course.id, [ctx.me.id])).get(ctx.me.id);
        const selfMark = ctx.canSelfMark && ctx.attendance.allowSelfMarking;
        const now = new Date();
        return rows
          .filter((r) => ctx.canViewAll || appliesTo(r.s, myGroups))
          .map(({ s, groupName }) => {
            const myStatus = all.find((r) => r.sessionId === s.id && r.userId === ctx.me.id)?.status ?? null;
            return {
              id: s.id,
              startsAt: s.startsAt,
              durationMinutes: s.durationMinutes,
              description: s.description,
              groupId: s.groupId,
              groupName: groupName ?? null,
              hasCode: !!s.selfMarkCodeHash,
              takenAt: s.takenAt,
              myStatus,
              selfMarkOpen: selfMark && !myStatus && appliesTo(s, myGroups) && withinSession(s, now),
              recorded: ctx.canViewAll ? all.filter((r) => r.sessionId === s.id).length : 0,
            };
          });
      }),
  );

  app.post(
    "/:activityId/sessions",
    {
      schema: {
        tags,
        summary: "Add a session, or repeat it weekly until a date (attendance:take)",
        params,
        body: zSessionInput.extend({ repeatUntil: zDateInput.nullable().optional() }),
        response: { 201: z.object({ created: z.number().int(), ids: z.array(zId) }) },
      },
    },
    async (req, reply) => {
      const out = await req.tenant(async (tx) => {
        const ctx = await loadAttendance(tx, req, req.params.activityId);
        requireTake(ctx);
        const b = req.body;
        if (b.groupId && !(await groupInCourse(tx, b.groupId, ctx.course.id))) throw badRequest("Unknown group");
        if (b.repeatUntil && b.repeatUntil < b.startsAt) throw badRequest("The repeat end date is before the first session");
        const dates = weeklyOccurrences(b.startsAt, b.repeatUntil, 52);
        const hash = b.selfMarkCode ? normalizeCode(b.selfMarkCode) : null;
        const created = await tx
          .insert(attendanceSessions)
          .values(
            dates.map((startsAt) => ({
              organizationId: req.org.id,
              attendanceId: ctx.attendance.id,
              groupId: b.groupId ?? null,
              startsAt,
              durationMinutes: b.durationMinutes,
              description: b.description || null,
              selfMarkCodeHash: hash,
            })),
          )
          .returning();
        for (const s of created) await syncCalendarEvent(tx, ctx.activity, s, ctx.me.id);
        await audit(tx, req, "attendance.sessions_created", { type: "activity", id: ctx.activity.id }, { count: created.length });
        return { created: created.length, ids: created.map((s) => s.id) };
      });
      return reply.status(201).send(out);
    },
  );

  app.patch(
    "/:activityId/sessions/:sessionId",
    {
      schema: {
        tags,
        summary: "Update a session (attendance:take). selfMarkCode: null removes the code.",
        params: sessionParams,
        body: zSessionInput.partial(),
        response: { 200: zOk },
      },
    },
    async (req) => {
      const payloads = await req.tenant(async (tx) => {
        const ctx = await loadAttendance(tx, req, req.params.activityId);
        requireTake(ctx);
        const s = await loadSession(tx, ctx, req.params.sessionId);
        const b = req.body;
        if (b.groupId && !(await groupInCourse(tx, b.groupId, ctx.course.id))) throw badRequest("Unknown group");
        const patch: Partial<typeof attendanceSessions.$inferInsert> = {};
        if (b.startsAt !== undefined) patch.startsAt = b.startsAt;
        if (b.durationMinutes !== undefined) patch.durationMinutes = b.durationMinutes;
        if (b.description !== undefined) patch.description = b.description || null;
        if (b.groupId !== undefined) patch.groupId = b.groupId;
        if (b.selfMarkCode !== undefined) patch.selfMarkCodeHash = b.selfMarkCode ? normalizeCode(b.selfMarkCode) : null;
        if (!Object.keys(patch).length) return [];
        const [updated] = await tx.update(attendanceSessions).set(patch).where(eq(attendanceSessions.id, s.id)).returning();
        await syncCalendarEvent(tx, ctx.activity, updated!, ctx.me.id);
        // Changing the audience of a taken session changes who it counts for.
        if (b.groupId !== undefined && b.groupId !== s.groupId && s.takenAt) {
          return recomputeGrades(tx, { activity: ctx.activity, course: ctx.course, attendance: ctx.attendance, userIds: await learnerIds(tx, ctx.course), gradedBy: ctx.me.id });
        }
        return [];
      });
      for (const p of payloads) await emit("grade.updated", p);
      return ok;
    },
  );

  app.delete(
    "/:activityId/sessions/:sessionId",
    { schema: { tags, summary: "Delete a session and its records (attendance:take)", params: sessionParams, response: { 200: zOk } } },
    async (req) => {
      const payloads = await req.tenant(async (tx) => {
        const ctx = await loadAttendance(tx, req, req.params.activityId);
        requireTake(ctx);
        const s = await loadSession(tx, ctx, req.params.sessionId);
        const recorded = await tx.select({ userId: attendanceRecords.userId }).from(attendanceRecords).where(eq(attendanceRecords.sessionId, s.id));
        await tx.delete(attendanceSessions).where(eq(attendanceSessions.id, s.id));
        await deleteCalendarEvent(tx, s.id);
        await audit(tx, req, "attendance.session_deleted", { type: "attendance_session", id: s.id }, { startsAt: s.startsAt.toISOString(), records: recorded.length });
        const affected = s.takenAt ? await eligibleLearners(tx, ctx, s) : [];
        return recomputeGrades(tx, {
          activity: ctx.activity,
          course: ctx.course,
          attendance: ctx.attendance,
          userIds: [...affected, ...recorded.map((r) => r.userId)],
          gradedBy: ctx.me.id,
        });
      });
      for (const p of payloads) await emit("grade.updated", p);
      return ok;
    },
  );

  app.get(
    "/:activityId/sessions/:sessionId",
    {
      schema: {
        tags,
        summary: "A session with its roster and records (attendance:take)",
        params: sessionParams,
        response: {
          200: zSession.omit({ myStatus: true, selfMarkOpen: true }).extend({
            roster: z.array(z.object({ user: zPerson, status: zStatus.nullable(), remarks: z.string().nullable(), takenAt: zNullableDate, selfMarked: z.boolean() })),
          }),
        },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const ctx = await loadAttendance(tx, req, req.params.activityId);
        requireTake(ctx);
        const s = await loadSession(tx, ctx, req.params.sessionId);
        const records = await tx.select().from(attendanceRecords).where(eq(attendanceRecords.sessionId, s.id));
        const eligible = await eligibleLearners(tx, ctx, s);
        const ids = [...new Set([...eligible, ...records.map((r) => r.userId)])];
        const people = await userSummaries(tx, ids);
        const groupName = s.groupId ? (await sessionsOf(tx, ctx.attendance.id)).find((r) => r.s.id === s.id)?.groupName ?? null : null;
        return {
          id: s.id,
          startsAt: s.startsAt,
          durationMinutes: s.durationMinutes,
          description: s.description,
          groupId: s.groupId,
          groupName,
          hasCode: !!s.selfMarkCodeHash,
          takenAt: s.takenAt,
          recorded: records.length,
          roster: ids
            .map((id) => {
              const r = records.find((x) => x.userId === id);
              return {
                user: people.get(id) ?? { id, firstName: "Unknown", lastName: "user" },
                status: r?.status ?? null,
                remarks: r?.remarks ?? null,
                takenAt: r?.takenAt ?? null,
                selfMarked: !!r && r.takenBy === id,
              };
            })
            .sort((a, b) => a.user.lastName.localeCompare(b.user.lastName) || a.user.firstName.localeCompare(b.user.firstName)),
        };
      }),
  );

  app.put(
    "/:activityId/sessions/:sessionId/records",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        tags,
        summary: "Take attendance: bulk upsert records for the session's learners (attendance:take)",
        params: sessionParams,
        body: z.object({
          records: z.array(z.object({ userId: zId, status: zStatus, remarks: z.string().trim().max(500).nullable().optional() })).min(1).max(2000),
        }),
        response: { 200: z.object({ saved: z.number().int() }) },
      },
    },
    async (req) => {
      const out = await req.tenant(async (tx) => {
        const ctx = await loadAttendance(tx, req, req.params.activityId);
        requireTake(ctx);
        const s = await loadSession(tx, ctx, req.params.sessionId);
        const eligible = new Set(await eligibleLearners(tx, ctx, s));
        const byUser = new Map(req.body.records.map((r) => [r.userId, r]));
        for (const id of byUser.keys()) if (!eligible.has(id)) throw badRequest(`User ${id} is not a learner of this session`);
        const now = new Date();
        for (const r of byUser.values()) {
          await tx
            .insert(attendanceRecords)
            .values({ organizationId: req.org.id, sessionId: s.id, userId: r.userId, status: r.status, remarks: r.remarks || null, takenBy: ctx.me.id, takenAt: now })
            .onConflictDoUpdate({
              target: [attendanceRecords.sessionId, attendanceRecords.userId],
              set: { status: r.status, remarks: r.remarks || null, takenBy: ctx.me.id, takenAt: now },
            });
        }
        await tx.update(attendanceSessions).set({ takenAt: now }).where(eq(attendanceSessions.id, s.id));
        await audit(tx, req, "attendance.taken", { type: "attendance_session", id: s.id }, { records: byUser.size });
        // The session is now "taken": it counts for every eligible learner (missing = absent).
        const payloads = await recomputeGrades(tx, { activity: ctx.activity, course: ctx.course, attendance: ctx.attendance, userIds: [...eligible], gradedBy: ctx.me.id });
        const attended = [...byUser.values()].filter((r) => r.status === "present" || r.status === "late").map((r) => r.userId);
        return { ctx, sessionId: s.id, saved: byUser.size, payloads, attended };
      });
      const base = { organizationId: req.org.id, activityId: out.ctx.activity.id, courseId: out.ctx.course.id };
      await emit("attendance.taken", { ...base, userId: out.ctx.me.id, sessionId: out.sessionId });
      for (const p of out.payloads) await emit("grade.updated", p);
      for (const userId of out.attended) await emit("activity.submitted", { ...base, userId });
      return { saved: out.saved };
    },
  );

  app.post(
    "/:activityId/sessions/:sessionId/self-mark",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags,
        summary: "Mark myself present during the session (requires the session code if one is set)",
        params: sessionParams,
        body: z.object({ code: z.string().trim().max(32).optional() }),
        response: { 200: z.object({ status: zStatus }) },
      },
    },
    async (req) => {
      const out = await req.tenant(async (tx) => {
        const ctx = await loadAttendance(tx, req, req.params.activityId);
        await requireCapability(tx, req, "attendance:self_mark", ctx.activity.contextId);
        if (!ctx.attendance.allowSelfMarking) throw forbidden("Self-marking is not enabled for this activity");
        const s = await loadSession(tx, ctx, req.params.sessionId);
        const g = (await groupMap(tx, ctx.course.id, [ctx.me.id])).get(ctx.me.id);
        if (!appliesTo(s, g)) throw notFound("Session");
        if (!withinSession(s)) throw new AppError(409, "SESSION_CLOSED", "You can only mark attendance while the session is running");
        if (s.selfMarkCodeHash) {
          if (!req.body.code) throw badRequest("Enter the session code");
          if (!safeEqual(normalizeCode(req.body.code), s.selfMarkCodeHash)) throw badRequest("Incorrect session code");
        }
        const status: AttendanceStatus = "present";
        const [created] = await tx
          .insert(attendanceRecords)
          .values({ organizationId: req.org.id, sessionId: s.id, userId: ctx.me.id, status, takenBy: ctx.me.id })
          .onConflictDoNothing()
          .returning();
        if (!created) throw conflict("Your attendance for this session is already recorded");
        const payloads: EventMap["grade.updated"][] = await recomputeGrades(tx, {
          activity: ctx.activity,
          course: ctx.course,
          attendance: ctx.attendance,
          userIds: [ctx.me.id],
          gradedBy: null,
        });
        return { ctx, status, payloads };
      });
      for (const p of out.payloads) await emit("grade.updated", p);
      await emit("activity.submitted", { organizationId: req.org.id, activityId: out.ctx.activity.id, courseId: out.ctx.course.id, userId: out.ctx.me.id });
      return { status: out.status };
    },
  );

  app.get(
    "/:activityId/report/me",
    {
      schema: {
        tags,
        summary: "My attendance: status per session and summary",
        params,
        response: {
          200: z.object({
            summary: zSummary,
            sessions: z.array(z.object({ id: zId, startsAt: zDate, durationMinutes: z.number().int(), description: z.string().nullable(), taken: z.boolean(), status: zStatus.nullable(), remarks: z.string().nullable() })),
          }),
        },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const ctx = await loadAttendance(tx, req, req.params.activityId);
        const g = (await groupMap(tx, ctx.course.id, [ctx.me.id])).get(ctx.me.id);
        const sessions = (await sessionsOf(tx, ctx.attendance.id)).map((r) => r.s).filter((s) => appliesTo(s, g));
        const records = sessions.length
          ? await tx
              .select()
              .from(attendanceRecords)
              .where(and(inArray(attendanceRecords.sessionId, sessions.map((s) => s.id)), eq(attendanceRecords.userId, ctx.me.id)))
          : [];
        return {
          summary: summarize(ctx.attendance, sessions, records, ctx.me.id, g),
          sessions: sessions.map((s) => {
            const r = records.find((x) => x.sessionId === s.id);
            return {
              id: s.id,
              startsAt: s.startsAt,
              durationMinutes: s.durationMinutes,
              description: s.description,
              taken: s.takenAt !== null,
              status: r?.status ?? (s.takenAt ? "absent" : null),
              remarks: r?.remarks ?? null,
            };
          }),
        };
      }),
  );

  app.get(
    "/:activityId/report",
    {
      schema: {
        tags,
        summary: "Everyone's attendance with percentages (attendance:view_all)",
        params,
        response: {
          200: z.object({
            sessions: z.array(z.object({ id: zId, startsAt: zDate, groupId: zId.nullable(), groupName: z.string().nullable(), taken: z.boolean() })),
            rows: z.array(z.object({ user: zPerson, statuses: z.record(zStatus.nullable()), summary: zSummary })),
          }),
        },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const ctx = await loadAttendance(tx, req, req.params.activityId);
        requireViewAll(ctx);
        const { sessionRows, rows } = await buildReport(tx, ctx);
        return {
          sessions: sessionRows.map(({ s, groupName }) => ({ id: s.id, startsAt: s.startsAt, groupId: s.groupId, groupName: groupName ?? null, taken: s.takenAt !== null })),
          rows,
        };
      }),
  );

  app.get(
    "/:activityId/report.csv",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: { tags, summary: "Download the attendance report as CSV (attendance:view_all)", params, response: { 200: z.string() } },
    },
    async (req, reply) => {
      const { csv, name } = await req.tenant(async (tx) => {
        const ctx = await loadAttendance(tx, req, req.params.activityId);
        requireViewAll(ctx);
        const { sessionRows, rows } = await buildReport(tx, ctx);
        const header = [
          "Last name",
          "First name",
          ...sessionRows.map(({ s, groupName }) => `${s.startsAt.toISOString().slice(0, 16).replace("T", " ")} UTC${groupName ? ` (${groupName})` : ""}`),
          "Present",
          "Late",
          "Excused",
          "Absent",
          "Points",
          "Max points",
          "Percentage",
          `Grade (/${ctx.attendance.gradeMax})`,
        ];
        const body = rows.map((r) => [
          r.user.lastName,
          r.user.firstName,
          ...sessionRows.map(({ s }) => (s.id in r.statuses ? (r.statuses[s.id] ?? (s.takenAt ? "absent" : "")) : "n/a")),
          r.summary.counts.present,
          r.summary.counts.late,
          r.summary.counts.excused,
          r.summary.counts.absent,
          r.summary.earned,
          r.summary.max,
          r.summary.percentage ?? "",
          r.summary.grade ?? "",
        ]);
        const name = ctx.activity.name.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "attendance";
        return { csv: toCsv([header, ...body]), name };
      });
      return reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="${name}-attendance.csv"`)
        .header("Cache-Control", "no-store")
        .send(`﻿${csv}`);
    },
  );
};
