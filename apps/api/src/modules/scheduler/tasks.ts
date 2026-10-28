import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, lte, or } from "drizzle-orm";
import {
  activities,
  assignmentSubmissions,
  assignments,
  authTokens,
  courseSections,
  courses,
  enrolments,
  jobs,
  ltiLaunches,
  notifications,
  organizations,
  quizAttempts,
  quizzes,
  roleAssignments,
  roles,
  scheduledTaskRuns,
  sessions,
  systemDb,
  users,
  videoMeetings,
  withTenant,
  type DB,
} from "@lms/db";
import { config } from "../../config";
import { emitInTx, pruneOutbox } from "../../core/events";
import { defineJob, enqueueJob, pruneJobs } from "../../core/jobs";
import { logger } from "../../core/logger";
import { queueMail } from "../../core/mail";
import { notify, type NotificationType } from "../../core/notify";
import { SUBMIT_GRACE_MS } from "../quiz/grading";
import { closeIfOverdue } from "../quiz/service";

/**
 * Cron-like scheduled tasks. The worker loop calls `runDueTasks()` every
 * SCHEDULER_TICK_MS; each task runs at most once per interval across all
 * replicas, using its `scheduled_task_runs` row as a lock (atomic upsert that
 * only succeeds when the task is due and not locked by another replica).
 */
export type ScheduledTask = { name: string; intervalMs: number; run: (now: Date) => Promise<unknown> };

export const SCHEDULER_TICK_MS = 30_000;
/** A crashed replica's lock expires after this, so the task is not stuck forever. */
const LOCK_MS = 15 * 60_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

/**
 * Atomically claims a task: inserts its row, or updates it only if the last run is older than the
 * interval and no other replica holds the lock. Returns true when this caller should run it.
 */
export async function claimTask(name: string, intervalMs: number, now = new Date(), force = false) {
  const db = await systemDb();
  const dueBefore = new Date(now.getTime() - intervalMs);
  const [row] = await db
    .insert(scheduledTaskRuns)
    .values({ name, lastRunAt: now, lockedUntil: new Date(now.getTime() + LOCK_MS) })
    .onConflictDoUpdate({
      target: scheduledTaskRuns.name,
      set: { lastRunAt: now, lockedUntil: new Date(now.getTime() + LOCK_MS) },
      where: force
        ? or(isNull(scheduledTaskRuns.lockedUntil), lt(scheduledTaskRuns.lockedUntil, now))
        : and(lte(scheduledTaskRuns.lastRunAt, dueBefore), or(isNull(scheduledTaskRuns.lockedUntil), lt(scheduledTaskRuns.lockedUntil, now))),
    })
    .returning({ name: scheduledTaskRuns.name });
  return !!row;
}

async function releaseTask(name: string) {
  const db = await systemDb();
  await db.update(scheduledTaskRuns).set({ lockedUntil: null }).where(eq(scheduledTaskRuns.name, name));
}

async function activeOrganizations() {
  const db = await systemDb();
  return (await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.status, "active"))).map((o) => o.id);
}

/** Runs `fn` for each active organization in its own tenant transaction; one org failing doesn't stop the others. */
async function forEachOrg(task: string, fn: (tx: DB, organizationId: string) => Promise<number>) {
  let total = 0;
  for (const orgId of await activeOrganizations()) {
    try {
      total += await withTenant(orgId, (tx) => fn(tx, orgId));
    } catch (err) {
      logger.error({ err, task, organizationId: orgId }, "scheduled task failed for organization");
    }
  }
  return total;
}

// ─── (a) Due-soon reminders ─────────────────────────────────────────────────

type Reminder = { userId: string; activityId: string; kind: "assignment" | "quiz" | "video"; deadline: Date; title: string; body: string; type: NotificationType };

type DueSoonPayload = { userId: string; type: NotificationType; title: string; body: string; link: string };

defineJob<DueSoonPayload>(
  "scheduler.due_soon",
  async (p, ctx) => {
    if (!ctx.tenantId) return;
    await withTenant(ctx.tenantId, (tx) =>
      notify(tx, { organizationId: ctx.tenantId!, userIds: [p.userId], type: p.type, title: p.title, body: p.body, link: p.link }),
    );
  },
  { maxAttempts: 3 },
);

/** Activity, its section and its course are all visible. */
const visibleActivity = and(eq(activities.visible, true), eq(courses.visible, true), eq(courseSections.visible, true));

/** courseId → user ids holding the student role with an active enrolment. */
async function learnersByCourse(tx: DB, courseIds: string[]) {
  const out = new Map<string, Set<string>>();
  if (!courseIds.length) return out;
  const rows = await tx
    .selectDistinct({ courseId: courses.id, userId: enrolments.userId })
    .from(enrolments)
    .innerJoin(courses, eq(courses.id, enrolments.courseId))
    .innerJoin(roleAssignments, and(eq(roleAssignments.userId, enrolments.userId), eq(roleAssignments.contextId, courses.contextId)))
    .innerJoin(roles, and(eq(roles.id, roleAssignments.roleId), eq(roles.archetype, "student")))
    .where(and(inArray(enrolments.courseId, courseIds), eq(enrolments.status, "active")));
  for (const r of rows) out.set(r.courseId, (out.get(r.courseId) ?? new Set()).add(r.userId));
  return out;
}

async function participantsByCourse(tx: DB, courseIds: string[]) {
  const out = new Map<string, Set<string>>();
  if (!courseIds.length) return out;
  const rows = await tx
    .select({ courseId: enrolments.courseId, userId: enrolments.userId })
    .from(enrolments)
    .where(and(inArray(enrolments.courseId, courseIds), eq(enrolments.status, "active")));
  for (const r of rows) out.set(r.courseId, (out.get(r.courseId) ?? new Set()).add(r.userId));
  return out;
}

/** Collects every reminder due for one organization (pure reads). */
export async function collectReminders(tx: DB, now: Date): Promise<Reminder[]> {
  const in24h = new Date(now.getTime() + 24 * HOUR);
  const in1h = new Date(now.getTime() + HOUR);
  const out: Reminder[] = [];

  // Assignments due within 24h, for students without a submitted/graded submission.
  const dueAssignments = await tx
    .select({ assignmentId: assignments.id, dueAt: assignments.dueAt, activity: activities, courseName: courses.fullname })
    .from(assignments)
    .innerJoin(activities, eq(activities.id, assignments.activityId))
    .innerJoin(courses, eq(courses.id, activities.courseId))
    .innerJoin(courseSections, eq(courseSections.id, activities.sectionId))
    .where(and(visibleActivity, isNotNull(assignments.dueAt), gt(assignments.dueAt, now), lte(assignments.dueAt, in24h)));
  if (dueAssignments.length) {
    const learners = await learnersByCourse(tx, [...new Set(dueAssignments.map((a) => a.activity.courseId))]);
    const submitted = await tx
      .select({ assignmentId: assignmentSubmissions.assignmentId, userId: assignmentSubmissions.userId })
      .from(assignmentSubmissions)
      .where(
        and(
          inArray(assignmentSubmissions.assignmentId, dueAssignments.map((a) => a.assignmentId)),
          inArray(assignmentSubmissions.status, ["submitted", "graded"]),
        ),
      );
    const done = new Set(submitted.map((s) => `${s.assignmentId}:${s.userId}`));
    for (const a of dueAssignments) {
      for (const userId of learners.get(a.activity.courseId) ?? []) {
        if (done.has(`${a.assignmentId}:${userId}`)) continue;
        out.push({
          userId,
          activityId: a.activity.id,
          kind: "assignment",
          deadline: a.dueAt!,
          type: "due_soon",
          title: `"${a.activity.name}" is due soon`,
          body: `The assignment "${a.activity.name}" in ${a.courseName} is due ${a.dueAt!.toISOString()}. You haven't submitted it yet.`,
        });
      }
    }
  }

  // Quizzes closing within 24h, for students with no finished (non-preview) attempt.
  const closingQuizzes = await tx
    .select({ quizId: quizzes.id, closeAt: quizzes.closeAt, activity: activities, courseName: courses.fullname })
    .from(quizzes)
    .innerJoin(activities, eq(activities.id, quizzes.activityId))
    .innerJoin(courses, eq(courses.id, activities.courseId))
    .innerJoin(courseSections, eq(courseSections.id, activities.sectionId))
    .where(and(visibleActivity, isNotNull(quizzes.closeAt), gt(quizzes.closeAt, now), lte(quizzes.closeAt, in24h)));
  if (closingQuizzes.length) {
    const learners = await learnersByCourse(tx, [...new Set(closingQuizzes.map((q) => q.activity.courseId))]);
    const finished = await tx
      .select({ quizId: quizAttempts.quizId, userId: quizAttempts.userId })
      .from(quizAttempts)
      .where(
        and(
          inArray(quizAttempts.quizId, closingQuizzes.map((q) => q.quizId)),
          eq(quizAttempts.status, "finished"),
          gt(quizAttempts.attempt, 0),
        ),
      );
    const done = new Set(finished.map((f) => `${f.quizId}:${f.userId}`));
    for (const q of closingQuizzes) {
      for (const userId of learners.get(q.activity.courseId) ?? []) {
        if (done.has(`${q.quizId}:${userId}`)) continue;
        out.push({
          userId,
          activityId: q.activity.id,
          kind: "quiz",
          deadline: q.closeAt!,
          type: "due_soon",
          title: `"${q.activity.name}" closes soon`,
          body: `The quiz "${q.activity.name}" in ${q.courseName} closes ${q.closeAt!.toISOString()}. You haven't completed an attempt yet.`,
        });
      }
    }
  }

  // Video meetings starting within 1h, for every active participant.
  const meetings = await tx
    .select({ startsAt: videoMeetings.startsAt, activity: activities, courseName: courses.fullname })
    .from(videoMeetings)
    .innerJoin(activities, eq(activities.id, videoMeetings.activityId))
    .innerJoin(courses, eq(courses.id, activities.courseId))
    .innerJoin(courseSections, eq(courseSections.id, activities.sectionId))
    .where(and(visibleActivity, gt(videoMeetings.startsAt, now), lte(videoMeetings.startsAt, in1h)));
  if (meetings.length) {
    const participants = await participantsByCourse(tx, [...new Set(meetings.map((m) => m.activity.courseId))]);
    for (const m of meetings) {
      for (const userId of participants.get(m.activity.courseId) ?? []) {
        out.push({
          userId,
          activityId: m.activity.id,
          kind: "video",
          deadline: m.startsAt,
          type: "video_meeting",
          title: `"${m.activity.name}" starts soon`,
          body: `The video meeting "${m.activity.name}" in ${m.courseName} starts ${m.startsAt.toISOString()}.`,
        });
      }
    }
  }
  return out;
}

/** Dedupe key per (user, activity, kind, deadline): a moved deadline gets a fresh reminder. */
export const reminderKey = (r: Pick<Reminder, "userId" | "activityId" | "kind" | "deadline">) =>
  `due_soon:${r.kind}:${r.activityId}:${r.deadline.toISOString()}:${r.userId}`;

/**
 * Queues one reminder job per (user, activity, kind). The job row (any status) is the dedupe marker:
 * done jobs are kept 14 days by pruneJobs(), far longer than the 24h reminder window.
 */
export async function queueDueSoonReminders(tx: DB, organizationId: string, now = new Date()) {
  const reminders = await collectReminders(tx, now);
  if (!reminders.length) return 0;
  const keys = reminders.map(reminderKey);
  const seen = new Set<string>();
  for (let i = 0; i < keys.length; i += 500) {
    const rows = await tx.select({ key: jobs.uniqueKey }).from(jobs).where(inArray(jobs.uniqueKey, keys.slice(i, i + 500)));
    for (const r of rows) if (r.key) seen.add(r.key);
  }
  let queued = 0;
  for (const r of reminders) {
    const key = reminderKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    const payload: DueSoonPayload = { userId: r.userId, type: r.type, title: r.title, body: r.body, link: `/activities/${r.activityId}` };
    await enqueueJob(tx, "scheduler.due_soon", payload, { tenantId: organizationId, uniqueKey: key });
    queued++;
  }
  return queued;
}

// ─── (b) Auto-finish overdue quiz attempts ──────────────────────────────────

/** Finishes one overdue attempt in its own transaction and stores the resulting events in the outbox. */
async function finishOverdueAttempt(organizationId: string, attemptId: string, now: Date) {
  return withTenant(organizationId, async (tx) => {
    const [row] = await tx
      .select({ attempt: quizAttempts, quiz: quizzes, activity: activities })
      .from(quizAttempts)
      .innerJoin(quizzes, eq(quizzes.id, quizAttempts.quizId))
      .innerJoin(activities, eq(activities.id, quizzes.activityId))
      .where(eq(quizAttempts.id, attemptId))
      .limit(1);
    if (!row) return false;
    const { events } = await closeIfOverdue(tx, row.quiz, row.activity, row.attempt, now);
    for (const e of events) await emitInTx(tx, e.name, e.payload as never);
    return true;
  });
}

export async function autoFinishOverdueAttempts(now = new Date()) {
  const db = await systemDb();
  // Cross-tenant listing (ids only); each attempt is then finished inside its own tenant transaction.
  const overdue = await db
    .select({ id: quizAttempts.id, organizationId: quizAttempts.organizationId })
    .from(quizAttempts)
    .where(and(eq(quizAttempts.status, "in_progress"), isNotNull(quizAttempts.dueAt), lt(quizAttempts.dueAt, new Date(now.getTime() - SUBMIT_GRACE_MS))))
    .limit(500);
  let finished = 0;
  for (const a of overdue) {
    try {
      if (await finishOverdueAttempt(a.organizationId, a.id, now)) finished++;
    } catch (err) {
      logger.error({ err, attemptId: a.id }, "auto-finishing quiz attempt failed");
    }
  }
  return finished;
}

// ─── (c) Daily notification digest ──────────────────────────────────────────

/** Most notifications listed in one digest email; the rest are summarized as a count. */
export const DIGEST_MAX_ITEMS = 50;

export function digestEmail(items: { title: string; body: string | null; link: string | null }[], appUrl: string) {
  const shown = items.slice(0, DIGEST_MAX_ITEMS);
  const lines = shown.map((n) => {
    const parts = [`• ${n.title}`];
    if (n.body) parts.push(`  ${n.body.replace(/\s+/g, " ").trim().slice(0, 300)}`);
    if (n.link) parts.push(`  ${appUrl}${n.link}`);
    return parts.join("\n");
  });
  const more = items.length - shown.length;
  if (more > 0) lines.push(`…and ${more} more.`);
  return {
    subject: items.length === 1 ? "Your daily summary: 1 new notification" : `Your daily summary: ${items.length} new notifications`,
    text: [...lines, `See all notifications: ${appUrl}/notifications`, "You get this summary because daily digest is on in your notification preferences."].join("\n\n"),
  };
}

/** Sends one email per digest user with everything that waited since the last digest. Returns emails queued. */
export async function sendDailyDigests(tx: DB, organizationId: string, now = new Date()) {
  const pending = await tx
    .select({ id: notifications.id, userId: notifications.userId, title: notifications.title, body: notifications.body, link: notifications.link, email: users.email })
    .from(notifications)
    .innerJoin(users, eq(users.id, notifications.userId))
    .where(and(isNull(notifications.emailedAt), eq(users.emailDigest, true), eq(users.status, "active"), lte(notifications.createdAt, now)))
    .orderBy(asc(notifications.userId), asc(notifications.createdAt));
  const byUser = new Map<string, typeof pending>();
  for (const n of pending) byUser.set(n.userId, [...(byUser.get(n.userId) ?? []), n]);
  for (const items of byUser.values()) {
    await queueMail(tx, organizationId, { to: items[0]!.email, ...digestEmail(items, config.APP_URL) });
  }
  // Marked in the same transaction as the queued email jobs, so a retry can't send twice.
  const ids = pending.map((n) => n.id);
  for (let i = 0; i < ids.length; i += 1000) {
    await tx.update(notifications).set({ emailedAt: now }).where(inArray(notifications.id, ids.slice(i, i + 1000)));
  }
  return byUser.size;
}

// ─── (d) Cleanup ────────────────────────────────────────────────────────────

export async function cleanup(now = new Date()) {
  const db = await systemDb();
  const idleCutoff = new Date(now.getTime() - config.SESSION_IDLE_MINUTES * MIN);
  await db.delete(sessions).where(or(lt(sessions.expiresAt, now), lt(sessions.lastSeenAt, idleCutoff)));
  await db.delete(authTokens).where(or(isNotNull(authTokens.usedAt), lt(authTokens.expiresAt, now)));
  await db.delete(ltiLaunches).where(lt(ltiLaunches.expiresAt, now));
  await pruneJobs();
  await pruneOutbox();
  return 0;
}

// ─── Registry ───────────────────────────────────────────────────────────────

export const scheduledTasks: ScheduledTask[] = [
  { name: "due_soon_reminders", intervalMs: 15 * MIN, run: (now) => forEachOrg("due_soon_reminders", (tx, org) => queueDueSoonReminders(tx, org, now)) },
  { name: "quiz_auto_finish", intervalMs: 5 * MIN, run: (now) => autoFinishOverdueAttempts(now) },
  { name: "cleanup", intervalMs: HOUR, run: (now) => cleanup(now) },
  { name: "notification_digest", intervalMs: 24 * HOUR, run: (now) => forEachOrg("notification_digest", (tx, org) => sendDailyDigests(tx, org, now)) },
];

/** Runs a task if due (or `force`, which still respects another replica's lock). Returns whether it ran. */
export async function runTask(task: ScheduledTask, opts: { now?: Date; force?: boolean } = {}) {
  const now = opts.now ?? new Date();
  if (!(await claimTask(task.name, task.intervalMs, now, opts.force))) return false;
  try {
    const result = await task.run(now);
    logger.debug({ task: task.name, result }, "scheduled task ran");
  } catch (err) {
    logger.error({ err, task: task.name }, "scheduled task failed");
  } finally {
    await releaseTask(task.name);
  }
  return true;
}

/** Worker tick: runs every task that is due. */
export async function runDueTasks(now = new Date()) {
  let ran = 0;
  for (const task of scheduledTasks) if (await runTask(task, { now })) ran++;
  return ran;
}

export const taskNamed = (name: string) => scheduledTasks.find((t) => t.name === name);
