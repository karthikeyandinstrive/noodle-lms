import { and, eq, isNull, lt, lte, sql } from "drizzle-orm";
import { eventLog, eventOutbox, systemDb, withTenant, type DB } from "@lms/db";
import { logger } from "./logger";

type Base = { organizationId: string; userId?: string | null; courseId?: string | null; activityId?: string | null };

/**
 * Every domain event in the system (Moodle "events API").
 * Modules emit these; other modules subscribe instead of importing each other.
 */
export type EventMap = {
  "user.created": Base & { userId: string };
  "user.enrolled": Base & { userId: string; courseId: string };
  "user.unenrolled": Base & { userId: string; courseId: string };
  "course.created": Base & { courseId: string };
  "course.completed": Base & { userId: string; courseId: string };

  "activity.created": Base & { activityId: string; courseId: string; type: string };
  "activity.updated": Base & { activityId: string; courseId: string; type: string };
  "activity.deleted": Base & { activityId: string; courseId: string; type: string };
  "activity.viewed": Base & { activityId: string; courseId: string; userId: string };
  /** Fired when a learner fulfils an activity's "submit" completion rule. */
  "activity.submitted": Base & { activityId: string; courseId: string; userId: string };
  "activity.completed": Base & { activityId: string; courseId: string; userId: string; state: string };

  "assignment.submitted": Base & { activityId: string; courseId: string; userId: string; submissionId: string };
  "assignment.graded": Base & { activityId: string; courseId: string; userId: string; submissionId: string };
  "quiz.attempt_started": Base & { activityId: string; courseId: string; userId: string; attemptId: string };
  "quiz.attempt_submitted": Base & { activityId: string; courseId: string; userId: string; attemptId: string };
  "forum.discussion_created": Base & { activityId: string; courseId: string; userId: string; discussionId: string };
  "forum.post_created": Base & {
    activityId: string;
    courseId: string;
    userId: string;
    discussionId: string;
    postId: string;
  };
  "workshop.phase_changed": Base & { activityId: string; courseId: string; phase: string };
  "attendance.taken": Base & { activityId: string; courseId: string; sessionId: string };
  "interactive.result": Base & { activityId: string; courseId: string; userId: string };
  "video.joined": Base & { activityId: string; courseId: string; userId: string };
  "lti.score": Base & { activityId: string; courseId: string; userId: string };
  "scorm.committed": Base & { activityId: string; courseId: string; userId: string; status: string };
  "message.sent": Base & { conversationId: string; messageId: string; userId: string };

  /** Emitted by the gradebook whenever a learner's grade for an item changes. */
  "grade.updated": Base & {
    courseId: string;
    userId: string;
    itemId: string;
    activityId: string | null;
    finalGrade: number | null;
    gradeMax: number;
    gradePass: number | null;
  };
  "certificate.issued": Base & { courseId: string; userId: string; issuedCertificateId: string };
  "badge.awarded": Base & { badgeId: string; userId: string };
  "payment.succeeded": Base & { orderId: string; courseId: string; userId: string };
};

export type EventName = keyof EventMap;
type Handler<K extends EventName> = (tx: DB, payload: EventMap[K]) => Promise<void>;
type Subscriber = { id: string; fn: Handler<EventName> };

const handlers = new Map<EventName, Subscriber[]>();

const MAX_ATTEMPTS = 8;
/** Lease while a dispatcher runs a row, so two dispatchers don't run the same event. */
const LEASE_MS = 5 * 60_000;

/**
 * Registers a subscriber. Each handler runs in its own tenant transaction and
 * is retried independently on failure (at-least-once), so handlers must be
 * idempotent. `id` must be stable across restarts (defaults to name + order).
 * Inside a handler, emit follow-up events with `emitInTx(tx, …)`, never `emit`.
 */
export function on<K extends EventName>(name: K, handler: Handler<K>, opts: { id?: string } = {}) {
  const list = handlers.get(name) ?? [];
  list.push({ id: opts.id ?? `${name}#${list.length}`, fn: handler as unknown as Handler<EventName> });
  handlers.set(name, list);
}

async function record(tx: DB, name: EventName, payload: Base) {
  await tx.insert(eventLog).values({
    organizationId: payload.organizationId,
    eventName: name,
    userId: payload.userId ?? null,
    courseId: payload.courseId ?? null,
    activityId: payload.activityId ?? null,
    data: payload as Record<string, unknown>,
  });
  const [row] = await tx
    .insert(eventOutbox)
    .values({ tenantId: payload.organizationId, name, payload: payload as Record<string, unknown> })
    .returning({ id: eventOutbox.id });
  return row!.id;
}

/**
 * Transactional emit: the event is stored in the outbox in the same
 * transaction as the change, and dispatched by the worker after commit.
 * Use inside `req.tenant(...)` and inside event handlers.
 */
export async function emitInTx<K extends EventName>(tx: DB, name: K, payload: EventMap[K]) {
  await record(tx, name, payload);
}

/**
 * Logs the event and runs its subscribers right away. Call AFTER the
 * originating transaction has committed (never inside `req.tenant(...)`).
 * The event is persisted first, so failed subscribers are retried by the worker.
 */
export async function emit<K extends EventName>(name: K, payload: EventMap[K]) {
  const id = await withTenant(payload.organizationId, (tx) => record(tx, name, payload));
  await dispatchById(id);
}

async function lease(id: string) {
  const db = await systemDb();
  const [row] = await db
    .update(eventOutbox)
    .set({ nextAttemptAt: new Date(Date.now() + LEASE_MS) })
    // Compare with the database clock: `next_attempt_at` defaults to the inserting transaction's
    // now() (microseconds), which a JS Date (milliseconds) taken right after can still precede.
    .where(and(eq(eventOutbox.id, id), isNull(eventOutbox.dispatchedAt), lte(eventOutbox.nextAttemptAt, sql`now()`)))
    .returning();
  return row;
}

async function dispatchById(id: string) {
  const row = await lease(id);
  if (row) await dispatchRow(row);
}

async function dispatchRow(row: typeof eventOutbox.$inferSelect) {
  const db = await systemDb();
  const name = row.name as EventName;
  const done = new Set(row.completedHandlers);
  let failure: unknown = null;

  for (const sub of handlers.get(name) ?? []) {
    if (done.has(sub.id)) continue;
    try {
      await withTenant(row.tenantId, (tx) => sub.fn(tx, row.payload as EventMap[EventName]));
      done.add(sub.id);
      await db.update(eventOutbox).set({ completedHandlers: [...done] }).where(eq(eventOutbox.id, row.id));
    } catch (err) {
      failure ??= err;
      logger.error({ err, event: name, subscriber: sub.id, attempt: row.attempts + 1 }, "event subscriber failed");
    }
  }

  if (!failure) {
    await db.update(eventOutbox).set({ dispatchedAt: new Date(), lastError: null }).where(eq(eventOutbox.id, row.id));
    return;
  }
  const attempts = row.attempts + 1;
  const giveUp = attempts >= MAX_ATTEMPTS;
  await db
    .update(eventOutbox)
    .set({
      attempts,
      lastError: `${giveUp ? "GAVE UP: " : ""}${String((failure as Error)?.stack ?? failure).slice(0, 4000)}`,
      dispatchedAt: giveUp ? new Date() : null,
      nextAttemptAt: new Date(Date.now() + 15_000 * 2 ** attempts),
    })
    .where(eq(eventOutbox.id, row.id));
}

/** Worker: dispatches events written with emitInTx and retries failed subscribers. */
export async function dispatchPendingEvents(limit = 50): Promise<number> {
  const db = await systemDb();
  const result = await db.execute(sql`
    update event_outbox set next_attempt_at = now() + interval '5 minutes'
    where id in (
      select id from event_outbox
      where dispatched_at is null and next_attempt_at <= now()
      order by created_at limit ${limit} for update skip locked
    )
    returning id
  `);
  const ids = (Array.isArray(result) ? result : (result as { rows: { id: string }[] }).rows) as { id: string }[];
  for (const { id } of ids) {
    const [row] = await db.select().from(eventOutbox).where(eq(eventOutbox.id, id));
    if (row) await dispatchRow(row);
  }
  return ids.length;
}

/** Deletes dispatched events older than `days` (event_log keeps the history). */
export async function pruneOutbox(days = 7) {
  const db = await systemDb();
  await db.delete(eventOutbox).where(lt(eventOutbox.dispatchedAt, new Date(Date.now() - days * 86_400_000)));
}
