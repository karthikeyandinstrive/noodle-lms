import { hostname } from "node:os";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { jobs, systemDb, type DB } from "@lms/db";
import { logger } from "./logger";

/**
 * Durable background jobs, stored in Postgres (`jobs` table) and claimed with
 * `FOR UPDATE SKIP LOCKED`, so any number of API/worker replicas can share the
 * queue and nothing is lost on restart. No Redis required.
 *
 *   defineJob("email.send", async (payload) => { ... })        // at module setup
 *   await enqueueJob(tx, "email.send", { to, subject }, { tenantId })  // inside the request tx → atomic
 *
 * Handlers must be idempotent: a job can run more than once (crash after the
 * work but before it is marked done). Payloads must be JSON.
 */

type JobContext = { jobId: string; attempt: number; tenantId: string | null };
type JobHandler = (payload: Record<string, unknown>, ctx: JobContext) => Promise<void>;
type JobDef = { handler: JobHandler; maxAttempts: number; backoffSeconds: number };

const registry = new Map<string, JobDef>();
const workerId = `${hostname()}:${process.pid}`;

export function defineJob<P extends Record<string, unknown>>(
  name: string,
  handler: (payload: P, ctx: JobContext) => Promise<void>,
  opts: { maxAttempts?: number; backoffSeconds?: number } = {},
) {
  registry.set(name, { handler: handler as JobHandler, maxAttempts: opts.maxAttempts ?? 5, backoffSeconds: opts.backoffSeconds ?? 30 });
}

export async function enqueueJob(
  tx: DB | null,
  name: string,
  payload: Record<string, unknown>,
  opts: { tenantId?: string | null; runAt?: Date; uniqueKey?: string; maxAttempts?: number } = {},
) {
  const db = tx ?? (await systemDb());
  if (opts.uniqueKey) {
    const [existing] = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.uniqueKey, opts.uniqueKey), inArray(jobs.status, ["queued", "running"])))
      .limit(1);
    if (existing) return existing.id;
  }
  const [row] = await db
    .insert(jobs)
    .values({
      name,
      payload,
      tenantId: opts.tenantId ?? null,
      runAt: opts.runAt ?? new Date(),
      uniqueKey: opts.uniqueKey ?? null,
      maxAttempts: opts.maxAttempts ?? registry.get(name)?.maxAttempts ?? 5,
    })
    .returning({ id: jobs.id });
  return row!.id;
}

/**
 * @deprecated Best-effort in-process task (lost on restart). Use defineJob/enqueueJob.
 * Kept for fire-and-forget work that is safe to lose.
 */
export function enqueue(name: string, fn: () => Promise<void>, attempts = 3) {
  const run = async (attempt: number) => {
    try {
      await fn();
    } catch (err) {
      if (attempt >= attempts) {
        logger.error({ err, job: name, attempt }, "in-process task failed permanently");
        return;
      }
      setTimeout(() => void run(attempt + 1), 2 ** attempt * 1000).unref();
    }
  };
  setImmediate(() => void run(1));
}

function rows<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

/** Claims and runs up to `limit` due jobs. Returns how many ran. */
export async function runDueJobs(limit = 10): Promise<number> {
  const db = await systemDb();
  // Jobs stuck in "running" (worker crashed) are released after 10 minutes.
  await db
    .update(jobs)
    .set({ status: "queued", lockedAt: null, lockedBy: null })
    .where(and(eq(jobs.status, "running"), lt(jobs.lockedAt, new Date(Date.now() - 10 * 60_000))));

  const claimed = rows<{ id: string; name: string; payload: Record<string, unknown>; attempts: number; max_attempts: number; tenant_id: string | null }>(
    await db.execute(sql`
      update jobs set status = 'running', locked_at = now(), locked_by = ${workerId}, attempts = attempts + 1
      where id in (
        select id from jobs where status = 'queued' and run_at <= now()
        order by run_at limit ${limit} for update skip locked
      )
      returning id, name, payload, attempts, max_attempts, tenant_id
    `),
  );

  for (const job of claimed) {
    const def = registry.get(job.name);
    try {
      if (!def) throw new Error(`No handler registered for job "${job.name}"`);
      await def.handler(job.payload, { jobId: job.id, attempt: job.attempts, tenantId: job.tenant_id });
      await db.update(jobs).set({ status: "done", finishedAt: new Date(), lockedAt: null, lockedBy: null }).where(eq(jobs.id, job.id));
    } catch (err) {
      const failed = job.attempts >= job.max_attempts;
      const backoff = (def?.backoffSeconds ?? 30) * 2 ** (job.attempts - 1);
      await db
        .update(jobs)
        .set({
          status: failed ? "failed" : "queued",
          lastError: String((err as Error)?.stack ?? err).slice(0, 4000),
          runAt: new Date(Date.now() + backoff * 1000),
          lockedAt: null,
          lockedBy: null,
          finishedAt: failed ? new Date() : null,
        })
        .where(eq(jobs.id, job.id));
      logger[failed ? "error" : "warn"]({ err, job: job.name, attempt: job.attempts }, failed ? "job failed permanently" : "job failed, will retry");
    }
  }
  return claimed.length;
}

/** Deletes finished jobs older than `days`. */
export async function pruneJobs(days = 14) {
  const db = await systemDb();
  await db.delete(jobs).where(and(eq(jobs.status, "done"), lt(jobs.finishedAt, new Date(Date.now() - days * 86_400_000))));
}
