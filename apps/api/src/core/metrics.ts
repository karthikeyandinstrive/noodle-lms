import { timingSafeEqual } from "node:crypto";
import { and, count, eq, isNotNull, isNull, min } from "drizzle-orm";
import fp from "fastify-plugin";
import { Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import { eventOutbox, jobs, systemDb } from "@lms/db";
import { config } from "../config";
import { logger } from "./logger";

/**
 * Prometheus metrics: process defaults, HTTP request durations (labelled by
 * route pattern, never the raw URL, to keep cardinality bounded) and queue /
 * outbox gauges. Exposed at GET /metrics behind METRICS_TOKEN (bearer).
 */
export const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry, prefix: "lms_" });

const httpDuration = new Histogram({
  name: "lms_http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status_code"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

/** Queue / outbox numbers shared by the metrics gauges and the system health page. */
export async function queueStats(tenantId?: string) {
  const db = await systemDb();
  const tenantJobs = tenantId ? eq(jobs.tenantId, tenantId) : undefined;
  const tenantEvents = tenantId ? eq(eventOutbox.tenantId, tenantId) : undefined;
  const [[queued], [failed], [pending], [failedEvents]] = await Promise.all([
    db.select({ n: count(), oldest: min(jobs.runAt) }).from(jobs).where(and(eq(jobs.status, "queued"), tenantJobs)),
    db.select({ n: count() }).from(jobs).where(and(eq(jobs.status, "failed"), tenantJobs)),
    db.select({ n: count(), oldest: min(eventOutbox.createdAt) }).from(eventOutbox).where(and(isNull(eventOutbox.dispatchedAt), tenantEvents)),
    db.select({ n: count() }).from(eventOutbox).where(and(isNotNull(eventOutbox.lastError), tenantEvents)),
  ]);
  const oldest = queued?.oldest ? new Date(queued.oldest) : null;
  return {
    queueDepth: Number(queued?.n ?? 0),
    /** Seconds since the oldest queued job became due (0 when it is scheduled in the future). */
    oldestQueuedAgeSeconds: oldest ? Math.max(0, Math.round((Date.now() - oldest.getTime()) / 1000)) : null,
    failedJobs: Number(failed?.n ?? 0),
    undispatchedEvents: Number(pending?.n ?? 0),
    oldestUndispatchedAt: pending?.oldest ? new Date(pending.oldest) : null,
    failedEvents: Number(failedEvents?.n ?? 0),
  };
}

let lastStats: { at: number; value: Promise<Awaited<ReturnType<typeof queueStats>>> } | null = null;
/** One query round per scrape, shared by every gauge. */
function scrapeStats() {
  if (!lastStats || Date.now() - lastStats.at > 1000) lastStats = { at: Date.now(), value: queueStats() };
  return lastStats.value;
}

function statGauge(name: string, help: string, pick: (s: Awaited<ReturnType<typeof queueStats>>) => number) {
  return new Gauge({
    name,
    help,
    registers: [metricsRegistry],
    async collect() {
      try {
        this.set(pick(await scrapeStats()));
      } catch (err) {
        logger.warn({ err, metric: name }, "metric collection failed");
      }
    },
  });
}

statGauge("lms_jobs_queued", "Background jobs waiting to run", (s) => s.queueDepth);
statGauge("lms_jobs_oldest_queued_age_seconds", "Age of the oldest due job", (s) => s.oldestQueuedAgeSeconds ?? 0);
statGauge("lms_jobs_failed", "Background jobs that failed permanently", (s) => s.failedJobs);
statGauge("lms_outbox_backlog", "Domain events not yet dispatched", (s) => s.undispatchedEvents);

function tokenMatches(header: string | undefined, token: string) {
  const given = Buffer.from(header?.startsWith("Bearer ") ? header.slice(7) : "");
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Registers the request-duration hook and GET /metrics (not encapsulated, so the hook sees every route). */
export const metricsPlugin = fp(async (app) => {
  app.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions.url;
    if (route === "/metrics") return;
    httpDuration.observe(
      { method: req.method, route: route ?? "unmatched", status_code: String(reply.statusCode) },
      reply.elapsedTime / 1000,
    );
  });

  app.get("/metrics", { config: { tenant: false, rateLimit: false }, schema: { hide: true } }, async (req, reply) => {
    // Disabled (and indistinguishable from a missing route) unless METRICS_TOKEN is set.
    if (!config.METRICS_TOKEN || !tokenMatches(req.headers.authorization, config.METRICS_TOKEN)) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Route not found" } });
    }
    reply.header("content-type", metricsRegistry.contentType);
    return metricsRegistry.metrics();
  });
});
