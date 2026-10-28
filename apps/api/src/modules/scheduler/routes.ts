import { and, count, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { eventOutbox, getSystemContext, jobs, scheduledTaskRuns, systemDb, type DB } from "@lms/db";
import { z } from "zod";
import pkg from "../../../package.json" with { type: "json" };
import { audit } from "../../core/audit";
import { requireUser } from "../../core/auth";
import { conflict, must } from "../../core/errors";
import { queueStats } from "../../core/metrics";
import { requireCapability } from "../../core/rbac";
import { redis } from "../../core/redis";
import { offset, ok, paged, zDate, zId, zNullableDate, zOk, zPagination } from "../../core/schemas";
import { scheduledTasks } from "./tasks";

const JOB_STATUSES = ["queued", "running", "done", "failed"] as const;

const zJob = z.object({
  id: zId,
  name: z.string(),
  status: z.enum(JOB_STATUSES),
  attempts: z.number().int(),
  maxAttempts: z.number().int(),
  runAt: zDate,
  createdAt: zDate,
  finishedAt: zNullableDate,
  lastError: z.string().nullable(),
});

const zFailedEvent = z.object({
  id: zId,
  name: z.string(),
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  completedHandlers: z.array(z.string()),
  createdAt: zDate,
  nextAttemptAt: zDate,
  dispatchedAt: zNullableDate,
  /** true when the dispatcher stopped retrying (max attempts reached). */
  gaveUp: z.boolean(),
});

const zStatus = z.enum(["ok", "error", "disabled"]);

/** Every route here needs site:view_system in the organization's system context. */
async function requireSystemViewer(tx: DB, req: FastifyRequest) {
  requireUser(req);
  const system = await getSystemContext(tx, req.org.id);
  await requireCapability(tx, req, "site:view_system", system.id);
}

export const routes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/health",
    {
      schema: {
        tags: ["System"],
        summary: "System health: database, Redis, job queue, event outbox and scheduled tasks",
        response: {
          200: z.object({
            version: z.string(),
            db: zStatus,
            redis: zStatus,
            queue: z.object({
              depth: z.number().int(),
              oldestQueuedAgeSeconds: z.number().int().nullable(),
              failedJobs: z.number().int(),
              undispatchedEvents: z.number().int(),
              failedEvents: z.number().int(),
            }),
            tasks: z.array(z.object({ name: z.string(), intervalSeconds: z.number().int(), lastRunAt: zNullableDate, running: z.boolean() })),
          }),
        },
      },
    },
    async (req) => {
      await req.tenant((tx) => requireSystemViewer(tx, req));
      // Outside the tenant transaction: these read platform tables with the system handle.
      let db: "ok" | "error" = "ok";
      try {
        await (await systemDb()).execute(sql`select 1`);
      } catch {
        db = "error";
      }
      let redisStatus: "ok" | "error" | "disabled" = "disabled";
      if (redis) {
        try {
          await redis.ping();
          redisStatus = "ok";
        } catch {
          redisStatus = "error";
        }
      }
      const stats = await queueStats(req.org.id);
      const runs = await (await systemDb())
        .select()
        .from(scheduledTaskRuns)
        .where(inArray(scheduledTaskRuns.name, scheduledTasks.map((t) => t.name)));
      const now = Date.now();
      return {
        version: pkg.version,
        db,
        redis: redisStatus,
        queue: {
          depth: stats.queueDepth,
          oldestQueuedAgeSeconds: stats.oldestQueuedAgeSeconds,
          failedJobs: stats.failedJobs,
          undispatchedEvents: stats.undispatchedEvents,
          failedEvents: stats.failedEvents,
        },
        tasks: scheduledTasks.map((t) => {
          const run = runs.find((r) => r.name === t.name);
          return {
            name: t.name,
            intervalSeconds: Math.round(t.intervalMs / 1000),
            lastRunAt: run?.lastRunAt ?? null,
            running: !!run?.lockedUntil && run.lockedUntil.getTime() > now,
          };
        }),
      };
    },
  );

  app.get(
    "/jobs",
    {
      schema: {
        tags: ["System"],
        summary: "Background jobs of this organization (payloads are never returned)",
        querystring: zPagination.extend({ status: z.enum(JOB_STATUSES).optional(), name: z.string().max(100).optional() }),
        response: { 200: paged(zJob) },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        await requireSystemViewer(tx, req);
        const q = req.query;
        // jobs has no RLS: always filter by tenant explicitly.
        const where = and(eq(jobs.tenantId, req.org.id), q.status ? eq(jobs.status, q.status) : undefined, q.name ? eq(jobs.name, q.name) : undefined);
        const [items, [total]] = await Promise.all([
          tx
            .select({
              id: jobs.id,
              name: jobs.name,
              status: jobs.status,
              attempts: jobs.attempts,
              maxAttempts: jobs.maxAttempts,
              runAt: jobs.runAt,
              createdAt: jobs.createdAt,
              finishedAt: jobs.finishedAt,
              lastError: jobs.lastError,
            })
            .from(jobs)
            .where(where)
            .orderBy(desc(jobs.createdAt))
            .limit(q.pageSize)
            .offset(offset(q)),
          tx.select({ n: count() }).from(jobs).where(where),
        ]);
        return { items, total: Number(total?.n ?? 0), page: q.page, pageSize: q.pageSize };
      }),
  );

  app.post(
    "/jobs/:id/retry",
    {
      schema: {
        tags: ["System"],
        summary: "Re-queue a failed job now (resets its attempts)",
        params: z.object({ id: zId }),
        response: { 200: zJob },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        await requireSystemViewer(tx, req);
        const job = must((await tx.select().from(jobs).where(and(eq(jobs.id, req.params.id), eq(jobs.tenantId, req.org.id))).limit(1))[0], "Job");
        if (job.status !== "failed") throw conflict("Only failed jobs can be retried");
        const [updated] = await tx
          .update(jobs)
          .set({ status: "queued", attempts: 0, runAt: new Date(), finishedAt: null, lockedAt: null, lockedBy: null })
          .where(and(eq(jobs.id, job.id), eq(jobs.tenantId, req.org.id)))
          .returning();
        await audit(tx, req, "system.job_retried", { type: "job", id: job.id }, { name: job.name });
        return updated!;
      }),
  );

  app.delete(
    "/jobs/:id",
    {
      schema: {
        tags: ["System"],
        summary: "Delete a queued or failed job",
        params: z.object({ id: zId }),
        response: { 200: zOk },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        await requireSystemViewer(tx, req);
        const job = must((await tx.select().from(jobs).where(and(eq(jobs.id, req.params.id), eq(jobs.tenantId, req.org.id))).limit(1))[0], "Job");
        if (job.status === "running") throw conflict("A running job cannot be deleted");
        await tx.delete(jobs).where(and(eq(jobs.id, job.id), eq(jobs.tenantId, req.org.id)));
        await audit(tx, req, "system.job_deleted", { type: "job", id: job.id }, { name: job.name, status: job.status });
        return ok;
      }),
  );

  app.get(
    "/failed-events",
    {
      schema: {
        tags: ["System"],
        summary: "Domain events whose subscribers failed (retrying or given up)",
        querystring: zPagination,
        response: { 200: paged(zFailedEvent) },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        await requireSystemViewer(tx, req);
        const q = req.query;
        const where = and(eq(eventOutbox.tenantId, req.org.id), isNotNull(eventOutbox.lastError));
        const [rows, [total]] = await Promise.all([
          tx.select().from(eventOutbox).where(where).orderBy(desc(eventOutbox.createdAt)).limit(q.pageSize).offset(offset(q)),
          tx.select({ n: count() }).from(eventOutbox).where(where),
        ]);
        return {
          items: rows.map((r) => ({
            id: r.id,
            name: r.name,
            attempts: r.attempts,
            lastError: r.lastError,
            completedHandlers: r.completedHandlers,
            createdAt: r.createdAt,
            nextAttemptAt: r.nextAttemptAt,
            dispatchedAt: r.dispatchedAt,
            gaveUp: !!r.dispatchedAt,
          })),
          total: Number(total?.n ?? 0),
          page: q.page,
          pageSize: q.pageSize,
        };
      }),
  );

  app.post(
    "/failed-events/:id/retry",
    {
      schema: {
        tags: ["System"],
        summary: "Retry an event's failed subscribers on the next dispatch (successful ones are not re-run)",
        params: z.object({ id: zId }),
        response: { 200: zOk },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        await requireSystemViewer(tx, req);
        const row = must(
          (
            await tx
              .update(eventOutbox)
          .set({ attempts: 0, nextAttemptAt: new Date(), dispatchedAt: null })
          .where(and(eq(eventOutbox.id, req.params.id), eq(eventOutbox.tenantId, req.org.id), isNotNull(eventOutbox.lastError)))
              .returning({ id: eventOutbox.id, name: eventOutbox.name })
          )[0],
          "Event",
        );
        await audit(tx, req, "system.event_retried", { type: "event", id: row.id }, { name: row.name });
        return ok;
      }),
  );
};
