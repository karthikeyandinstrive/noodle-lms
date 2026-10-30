import { and, eq, inArray } from "drizzle-orm";
import { afterCommit, notificationPreferences, notifications, users, type DB } from "@lms/db";
import { config } from "../config";
import { publishLive } from "./live";
import { queueMail } from "./mail";

/**
 * Notification types. Users can toggle in-app/email per type
 * (see modules/notifications). Add new types here.
 */
export const NOTIFICATION_TYPES = {
  enrolment: "You were enrolled in a course",
  assignment_graded: "Your assignment was graded",
  assignment_submitted: "A student submitted an assignment",
  assignment_due: "Assignment due soon",
  quiz_graded: "Your quiz attempt was graded",
  forum_post: "New post in a forum you follow",
  workshop_phase: "Workshop phase changed",
  certificate_issued: "You earned a certificate",
  badge_awarded: "You earned a badge",
  course_completed: "You completed a course",
  payment: "Payment receipts",
  announcement: "Course announcements",
  video_meeting: "Video meeting reminders",
  due_soon: "Deadlines in the next 24 hours",
  grade_updated: "A teacher changed one of your grades",
  message: "New private messages",
  backup_ready: "Course backup or restore finished",
  security: "Security alerts (new sign-in, MFA changes)",
} as const;
export type NotificationType = keyof typeof NOTIFICATION_TYPES;

/**
 * Creates in-app notifications (inside the caller's transaction) and queues
 * emails for recipients who have email enabled for this type. Recipients on the
 * daily digest get no email now; their notification row stays pending
 * (`emailedAt` null) until the digest task sends it.
 */
export async function notify(
  tx: DB,
  input: {
    organizationId: string;
    userIds: string[];
    type: NotificationType;
    title: string;
    body?: string;
    /** Relative app path, e.g. /courses/<id> */
    link?: string;
  },
) {
  const userIds = [...new Set(input.userIds)];
  if (!userIds.length) return;

  const prefs = await tx
    .select()
    .from(notificationPreferences)
    .where(and(inArray(notificationPreferences.userId, userIds), eq(notificationPreferences.type, input.type)));
  const prefOf = new Map(prefs.map((p) => [p.userId, p]));

  const emailIds = userIds.filter((id) => prefOf.get(id)?.email ?? true);
  const recipients = emailIds.length
    ? await tx
        .select({ id: users.id, email: users.email, emailDigest: users.emailDigest })
        .from(users)
        .where(and(inArray(users.id, emailIds), eq(users.status, "active")))
    : [];
  const digest = new Set(recipients.filter((r) => r.emailDigest).map((r) => r.id));

  // Digest recipients need a row for the digest to pick up, even with in-app delivery off;
  // it's then stored as already read so it doesn't show as unread.
  const now = new Date();
  const rows = userIds.filter((id) => (prefOf.get(id)?.inApp ?? true) || digest.has(id));
  if (rows.length) {
    await tx.insert(notifications).values(
      rows.map((userId) => ({
        organizationId: input.organizationId,
        userId,
        type: input.type,
        title: input.title,
        body: input.body ?? null,
        link: input.link ?? null,
        readAt: (prefOf.get(userId)?.inApp ?? true) ? null : now,
        emailedAt: digest.has(userId) ? null : now,
      })),
    );
    const unread = rows.filter((id) => prefOf.get(id)?.inApp ?? true);
    afterCommit(tx, () => publishLive(unread, { type: "notification" }));
  }

  // Emails are durable jobs written in the caller's transaction: sent only if it commits.
  const link = input.link ? `${config.APP_URL}${input.link}` : undefined;
  for (const r of recipients) {
    if (digest.has(r.id)) continue;
    await queueMail(tx, input.organizationId, {
      to: r.email,
      subject: input.title,
      text: [input.body, link].filter(Boolean).join("\n\n") || input.title,
    });
  }
}
