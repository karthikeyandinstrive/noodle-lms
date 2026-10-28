import { and, eq, inArray } from "drizzle-orm";
import { notificationPreferences, notifications, users, withTenant, type DB } from "@lms/db";
import { config } from "../config";
import { enqueue } from "./jobs";
import { sendMail } from "./mail";

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
} as const;
export type NotificationType = keyof typeof NOTIFICATION_TYPES;

/**
 * Creates in-app notifications (inside the caller's transaction) and queues
 * emails for recipients who have email enabled for this type.
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

  const inApp = userIds.filter((id) => prefOf.get(id)?.inApp ?? true);
  if (inApp.length) {
    await tx.insert(notifications).values(
      inApp.map((userId) => ({
        organizationId: input.organizationId,
        userId,
        type: input.type,
        title: input.title,
        body: input.body ?? null,
        link: input.link ?? null,
      })),
    );
  }

  const emailIds = userIds.filter((id) => prefOf.get(id)?.email ?? true);
  if (!emailIds.length) return;
  enqueue(`notify-email:${input.type}`, async () => {
    const recipients = await withTenant(input.organizationId, (t) =>
      t.select({ email: users.email }).from(users).where(and(inArray(users.id, emailIds), eq(users.status, "active"))),
    );
    const link = input.link ? `${config.APP_URL}${input.link}` : undefined;
    for (const r of recipients) {
      await sendMail({
        to: r.email,
        subject: input.title,
        text: [input.body, link].filter(Boolean).join("\n\n") || input.title,
      });
    }
  });
}
