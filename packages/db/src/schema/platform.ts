import { index, integer, jsonb, pgEnum, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, ts } from "./_common";

// These tables are intentionally NOT tenant-scoped (no organization_id column, no RLS):
// the worker processes rows for every organization. Payloads carry the organization id.

export const jobStatus = pgEnum("job_status", ["queued", "running", "done", "failed"]);

/**
 * Durable background jobs (Postgres-backed queue, `FOR UPDATE SKIP LOCKED`).
 * See apps/api/src/core/jobs.ts.
 */
export const jobs = pgTable(
  "jobs",
  {
    id: id(),
    tenantId: uuid(),
    name: text().notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    status: jobStatus().notNull().default("queued"),
    runAt: ts().notNull().defaultNow(),
    attempts: integer().notNull().default(0),
    maxAttempts: integer().notNull().default(5),
    lastError: text(),
    lockedAt: ts(),
    lockedBy: text(),
    /** Optional dedupe key: only one queued/running job per key. */
    uniqueKey: text(),
    createdAt: createdAt(),
    finishedAt: ts(),
  },
  (t) => [index("jobs_ready_idx").on(t.status, t.runAt), index("jobs_unique_key_idx").on(t.uniqueKey)],
);

/**
 * Transactional outbox for domain events: written in the same transaction as
 * the change, dispatched by the worker after commit. See core/events.ts.
 */
export const eventOutbox = pgTable(
  "event_outbox",
  {
    id: id(),
    tenantId: uuid().notNull(),
    name: text().notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    attempts: integer().notNull().default(0),
    lastError: text(),
    /** Subscriber ids that already succeeded, so retries only re-run the failed ones. */
    completedHandlers: text().array().notNull().default([]),
    nextAttemptAt: ts().notNull().defaultNow(),
    createdAt: createdAt(),
    dispatchedAt: ts(),
  },
  (t) => [index("event_outbox_pending_idx").on(t.dispatchedAt, t.createdAt)],
);

/** Last run of each scheduled (cron) task, so multiple API replicas don't double-run. */
export const scheduledTaskRuns = pgTable("scheduled_task_runs", {
  name: text().primaryKey(),
  lastRunAt: ts().notNull(),
  lockedUntil: ts(),
});
