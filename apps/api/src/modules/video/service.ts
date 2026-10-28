import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { activities, calendarEvents, videoMeetings, type DB } from "@lms/db";
import { z } from "zod";
import { registerActivityType, type ActivityRow } from "../../core/activity-types";
import { badRequest } from "../../core/errors";
import { on } from "../../core/events";
import { zDateInput } from "../../core/schemas";
import { httpsUrl, jitsiRoomName } from "./meeting";

export type MeetingRow = typeof videoMeetings.$inferSelect;

export async function meetingOf(tx: DB, activityId: string) {
  const [row] = await tx.select().from(videoMeetings).where(eq(videoMeetings.activityId, activityId)).limit(1);
  return row ?? null;
}

function newRoomName(activity: ActivityRow) {
  return jitsiRoomName(activity.organizationId, activity.id, randomBytes(16).toString("hex"));
}

function optionalHttps(value: string | null | undefined, field: string) {
  if (value === undefined) return undefined;
  if (value === null || value.trim() === "") return null;
  const url = httpsUrl(value);
  if (!url) throw badRequest(`${field} must be a valid https:// URL`);
  return url;
}

/** Keeps one "session" calendar event per meeting in sync with the activity. */
export async function syncCalendar(tx: DB, activity: ActivityRow, meeting: Pick<MeetingRow, "startsAt" | "durationMinutes">) {
  const where = and(eq(calendarEvents.activityId, activity.id), eq(calendarEvents.type, "session"));
  const [existing] = await tx.select({ id: calendarEvents.id }).from(calendarEvents).where(where).limit(1);
  const values = { name: activity.name, startsAt: meeting.startsAt, durationMinutes: meeting.durationMinutes, courseId: activity.courseId };
  if (existing) await tx.update(calendarEvents).set(values).where(eq(calendarEvents.id, existing.id));
  else {
    await tx.insert(calendarEvents).values({
      ...values,
      organizationId: activity.organizationId,
      type: "session",
      activityId: activity.id,
      createdBy: activity.createdBy,
    });
  }
}

const settings = z.object({
  provider: z.enum(["jitsi", "zoom", "bigbluebutton", "custom"]).default("jitsi"),
  startsAt: zDateInput,
  durationMinutes: z.number().int().min(5).max(24 * 60).default(60),
  /** Required for non-Jitsi providers (https only). Never returned by `load`. */
  joinUrl: z.string().max(2000).nullable().optional(),
  recordingUrl: z.string().max(2000).nullable().optional(),
});

export function setupVideo() {
  registerActivityType({
    type: "video",
    label: "Video meeting",
    settings,
    async create(tx, { activity }, s) {
      const provider = s.provider ?? "jitsi";
      const joinUrl = provider === "jitsi" ? null : (optionalHttps(s.joinUrl, "Join URL") ?? null);
      if (provider !== "jitsi" && !joinUrl) throw badRequest("A https:// join URL is required for this provider");
      const [meeting] = await tx
        .insert(videoMeetings)
        .values({
          organizationId: activity.organizationId,
          activityId: activity.id,
          provider,
          roomName: provider === "jitsi" ? newRoomName(activity) : null,
          joinUrl,
          startsAt: s.startsAt,
          durationMinutes: s.durationMinutes ?? 60,
          recordingUrl: optionalHttps(s.recordingUrl, "Recording URL") ?? null,
        })
        .returning();
      await syncCalendar(tx, activity, meeting!);
    },
    async update(tx, { activity }, s) {
      const row = await meetingOf(tx, activity.id);
      if (!row) throw badRequest("Meeting settings are missing");
      const provider = s.provider ?? row.provider;
      const patch: Partial<typeof videoMeetings.$inferInsert> = { provider };
      if (s.startsAt !== undefined) patch.startsAt = s.startsAt;
      if (s.durationMinutes !== undefined) patch.durationMinutes = s.durationMinutes;
      const recording = optionalHttps(s.recordingUrl, "Recording URL");
      if (recording !== undefined) patch.recordingUrl = recording;
      if (provider === "jitsi") {
        patch.joinUrl = null;
        if (!row.roomName) patch.roomName = newRoomName(activity);
      } else {
        // An empty/omitted join URL keeps the stored one (the edit form never receives it).
        const next = s.joinUrl ? optionalHttps(s.joinUrl, "Join URL") : row.joinUrl;
        if (!next) throw badRequest("A https:// join URL is required for this provider");
        patch.joinUrl = next;
      }
      const [updated] = await tx.update(videoMeetings).set(patch).where(eq(videoMeetings.id, row.id)).returning();
      await syncCalendar(tx, activity, updated!);
    },
    async load(tx, activity) {
      const row = await meetingOf(tx, activity.id);
      if (!row) return null;
      return {
        provider: row.provider,
        startsAt: row.startsAt.toISOString(),
        durationMinutes: row.durationMinutes,
        recordingUrl: row.recordingUrl,
        hasJoinUrl: row.provider === "jitsi" ? !!row.roomName : !!row.joinUrl,
      };
    },
  });

  // Calendar events reference the activity loosely (no FK): clean up / rename on activity changes.
  on("activity.deleted", async (tx, p) => {
    if (p.type !== "video") return;
    await tx.delete(calendarEvents).where(and(eq(calendarEvents.activityId, p.activityId), eq(calendarEvents.type, "session")));
  });
  on("activity.updated", async (tx, p) => {
    if (p.type !== "video") return;
    const [activity] = await tx.select().from(activities).where(eq(activities.id, p.activityId)).limit(1);
    const meeting = activity ? await meetingOf(tx, activity.id) : null;
    if (activity && meeting) await syncCalendar(tx, activity, meeting);
  });
}
