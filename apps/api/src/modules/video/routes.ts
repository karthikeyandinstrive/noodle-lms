import { and, asc, eq, inArray } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { enrolments, users, videoAttendance } from "@lms/db";
import { z } from "zod";
import { requireUser } from "../../core/auth";
import { AppError, notFound } from "../../core/errors";
import { emit } from "../../core/events";
import { hasCapability } from "../../core/rbac";
import { zDate, zId, zNullableDate, zUserSummary } from "../../core/schemas";
import { loadActivity } from "../activities/service";
import { jitsiJoinUrl, joinWindow } from "./meeting";
import { meetingOf } from "./service";

const activityParam = z.object({ activityId: zId });

export const routes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/:activityId/status",
    {
      schema: {
        tags: ["Video"],
        summary: "Meeting schedule, join window and my attendance",
        params: activityParam,
        response: {
          200: z.object({
            provider: z.string(),
            startsAt: zDate,
            endsAt: zDate,
            opensAt: zDate,
            closesAt: zDate,
            open: z.boolean(),
            canJoin: z.boolean(),
            canModerate: z.boolean(),
            myFirstJoinAt: zNullableDate,
            recordingUrl: z.string().nullable(),
            serverTime: zDate,
          }),
        },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const me = requireUser(req);
        const { activity } = await loadActivity(tx, req, req.params.activityId, { type: "video" });
        const meeting = await meetingOf(tx, activity.id);
        if (!meeting) throw notFound("Meeting");
        const now = new Date();
        const w = joinWindow(meeting.startsAt, meeting.durationMinutes, now);
        const canModerate = await hasCapability(tx, req, "video:moderate", activity.contextId);
        const canJoinCap = await hasCapability(tx, req, "video:join", activity.contextId);
        const [mine] = await tx
          .select({ joinedAt: videoAttendance.joinedAt })
          .from(videoAttendance)
          .where(and(eq(videoAttendance.meetingId, meeting.id), eq(videoAttendance.userId, me.id)))
          .orderBy(asc(videoAttendance.joinedAt))
          .limit(1);
        return {
          provider: meeting.provider,
          startsAt: meeting.startsAt,
          endsAt: new Date(meeting.startsAt.getTime() + meeting.durationMinutes * 60_000),
          opensAt: w.opensAt,
          closesAt: w.closesAt,
          open: w.open,
          canJoin: canJoinCap && (w.open || canModerate),
          canModerate,
          myFirstJoinAt: mine?.joinedAt ?? null,
          recordingUrl: meeting.recordingUrl,
          serverTime: now,
        };
      }),
  );

  app.post(
    "/:activityId/join",
    {
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        tags: ["Video"],
        summary: "Join the meeting: returns the provider URL and records attendance",
        params: activityParam,
        body: z.object({}).optional(),
        response: { 200: z.object({ url: z.string(), provider: z.string() }) },
      },
    },
    async (req) => {
      const me = requireUser(req);
      const out = await req.tenant(async (tx) => {
        const { activity } = await loadActivity(tx, req, req.params.activityId, { type: "video", capability: "video:join" });
        const meeting = await meetingOf(tx, activity.id);
        if (!meeting) throw notFound("Meeting");
        const moderator = await hasCapability(tx, req, "video:moderate", activity.contextId);
        const w = joinWindow(meeting.startsAt, meeting.durationMinutes);
        if (!w.open && !moderator) {
          throw new AppError(403, "NOT_AVAILABLE", `You can join between ${w.opensAt.toISOString()} and ${w.closesAt.toISOString()}`);
        }
        let url: string;
        if (meeting.provider === "jitsi") {
          if (!meeting.roomName) throw notFound("Meeting room");
          url = jitsiJoinUrl(meeting.roomName, `${me.firstName} ${me.lastName}`.trim(), { moderator, subject: activity.name });
        } else {
          if (!meeting.joinUrl) throw notFound("Meeting link");
          url = meeting.joinUrl;
        }
        await tx.insert(videoAttendance).values({ organizationId: req.org.id, meetingId: meeting.id, userId: me.id });
        return { url, provider: meeting.provider, activity };
      });
      const payload = { organizationId: req.org.id, activityId: out.activity.id, courseId: out.activity.courseId, userId: me.id };
      await emit("video.joined", payload);
      await emit("activity.submitted", payload);
      return { url: out.url, provider: out.provider };
    },
  );

  app.get(
    "/:activityId/attendance",
    {
      schema: {
        tags: ["Video"],
        summary: "Attendance report (video:moderate)",
        params: activityParam,
        response: {
          200: z.object({
            enrolledCount: z.number().int(),
            rows: z.array(z.object({ user: zUserSummary, firstJoinedAt: zDate, lastJoinedAt: zDate, joins: z.number().int() })),
          }),
        },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const { activity } = await loadActivity(tx, req, req.params.activityId, { type: "video", capability: "video:moderate" });
        const meeting = await meetingOf(tx, activity.id);
        if (!meeting) throw notFound("Meeting");
        const rows = await tx
          .select()
          .from(videoAttendance)
          .where(eq(videoAttendance.meetingId, meeting.id))
          .orderBy(asc(videoAttendance.joinedAt))
          .limit(50_000);
        const agg = new Map<string, { first: Date; last: Date; joins: number }>();
        for (const r of rows) {
          const a = agg.get(r.userId);
          if (a) {
            a.last = r.joinedAt;
            a.joins++;
          } else agg.set(r.userId, { first: r.joinedAt, last: r.joinedAt, joins: 1 });
        }
        const enrolled = await tx
          .select({ id: enrolments.id })
          .from(enrolments)
          .where(and(eq(enrolments.courseId, activity.courseId), eq(enrolments.status, "active")));
        if (!agg.size) return { enrolledCount: enrolled.length, rows: [] };
        const people = await tx
          .select({ id: users.id, firstName: users.firstName, lastName: users.lastName, email: users.email })
          .from(users)
          .where(inArray(users.id, [...agg.keys()]));
        return {
          enrolledCount: enrolled.length,
          rows: people
            .map((u) => {
              const a = agg.get(u.id)!;
              return { user: u, firstJoinedAt: a.first, lastJoinedAt: a.last, joins: a.joins };
            })
            .sort((x, y) => x.firstJoinedAt.getTime() - y.firstJoinedAt.getTime()),
        };
      }),
  );
};
