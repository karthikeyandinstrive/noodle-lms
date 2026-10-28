/**
 * Core platform: durable job queue (core/jobs) and transactional outbox (core/events).
 * In-memory database; the worker loop is not started, so the test drives it.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, eventOutbox, jobs, systemDb, users, withTenant } from "@lms/db";
import { config } from "../src/config";
import { dispatchPendingEvents, emit, emitInTx, on } from "../src/core/events";
import { defineJob, enqueueJob, runDueJobs } from "../src/core/jobs";
import { Client, setup, type TestEnv } from "./helpers";

let env: TestEnv;
let orgId: string;
let userId: string;

const jobById = async (id: string) => (await (await systemDb()).select().from(jobs).where(eq(jobs.id, id)))[0]!;
const makeDue = async (id: string) => (await systemDb()).update(jobs).set({ runAt: new Date(Date.now() - 1000) }).where(eq(jobs.id, id));

beforeAll(async () => {
  env = await setup();
  orgId = env.orgs.default!.id;
  const [admin] = await (await systemDb()).select().from(users).where(eq(users.email, "admin@default.test"));
  userId = admin!.id;
  while ((await runDueJobs(50)) > 0); // anything queued by setup
});

afterAll(async () => {
  await env.app.close();
  await closeDb();
});

describe("job queue", () => {
  it("retries with exponential backoff, then fails permanently", async () => {
    let calls = 0;
    defineJob(
      "test.always_fails",
      async () => {
        calls++;
        throw new Error(`failure ${calls}`);
      },
      { maxAttempts: 3, backoffSeconds: 10 },
    );
    const id = await enqueueJob(null, "test.always_fails", { n: 1 }, { tenantId: orgId });

    let before = Date.now();
    await runDueJobs();
    let job = await jobById(id);
    expect(job).toMatchObject({ status: "queued", attempts: 1, lockedBy: null });
    expect(job.lastError).toContain("failure 1");
    expect(job.runAt.getTime() - before).toBeGreaterThanOrEqual(9_000); // 10s * 2^0
    expect(job.runAt.getTime() - before).toBeLessThan(15_000);

    await runDueJobs(); // not due yet
    expect(calls).toBe(1);

    await makeDue(id);
    before = Date.now();
    await runDueJobs();
    job = await jobById(id);
    expect(job).toMatchObject({ status: "queued", attempts: 2 });
    expect(job.runAt.getTime() - before).toBeGreaterThanOrEqual(19_000); // 10s * 2^1

    await makeDue(id);
    await runDueJobs();
    job = await jobById(id);
    expect(job).toMatchObject({ status: "failed", attempts: 3 });
    expect(job.finishedAt).not.toBeNull();
    expect(job.lastError).toContain("failure 3");

    await makeDue(id);
    await runDueJobs(); // failed jobs are never picked up again
    expect(calls).toBe(3);
  });

  it("runs a job once and marks it done", async () => {
    const seen: unknown[] = [];
    defineJob("test.ok", async (payload, ctx) => {
      seen.push({ payload, tenantId: ctx.tenantId, attempt: ctx.attempt });
    });
    const id = await enqueueJob(null, "test.ok", { hello: "world" }, { tenantId: orgId });
    await runDueJobs();
    await runDueJobs();
    expect(seen).toEqual([{ payload: { hello: "world" }, tenantId: orgId, attempt: 1 }]);
    expect((await jobById(id)).status).toBe("done");
  });

  it("dedupes queued jobs by uniqueKey", async () => {
    let calls = 0;
    defineJob("test.unique", async () => {
      calls++;
    });
    const a = await enqueueJob(null, "test.unique", {}, { uniqueKey: "test:unique:1" });
    const b = await enqueueJob(null, "test.unique", {}, { uniqueKey: "test:unique:1" });
    const c = await enqueueJob(null, "test.unique", {}, { uniqueKey: "test:unique:2" });
    expect(b).toBe(a);
    expect(c).not.toBe(a);
    const rows = await (await systemDb()).select().from(jobs).where(eq(jobs.name, "test.unique"));
    expect(rows).toHaveLength(2);
    await runDueJobs();
    expect(calls).toBe(2);
    // Once done, the key is free again.
    const d = await enqueueJob(null, "test.unique", {}, { uniqueKey: "test:unique:1" });
    expect(d).not.toBe(a);
  });

  it("does not run a job enqueued in a transaction that rolled back", async () => {
    let calls = 0;
    defineJob("test.rollback", async () => {
      calls++;
    });
    await expect(
      withTenant(orgId, async (tx) => {
        await enqueueJob(tx, "test.rollback", {}, { tenantId: orgId });
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    await runDueJobs();
    expect(calls).toBe(0);
    expect(await (await systemDb()).select().from(jobs).where(eq(jobs.name, "test.rollback"))).toHaveLength(0);
  });
});

describe("event outbox", () => {
  const calls = { first: 0, second: 0 };
  let failSecond = true;
  // Test-only subscribers on an existing event; other subscribers of badge.awarded are unaffected.
  on(
    "badge.awarded",
    async (_tx, p) => {
      if (p.badgeId === "00000000-0000-4000-8000-000000000001") calls.first++;
    },
    { id: "test.platform.first" },
  );
  on(
    "badge.awarded",
    async (_tx, p) => {
      if (p.badgeId !== "00000000-0000-4000-8000-000000000001") return;
      calls.second++;
      if (failSecond) throw new Error("second subscriber failed");
    },
    { id: "test.platform.second" },
  );

  it("retries only the failed subscriber", async () => {
    await emit("badge.awarded", { organizationId: orgId, userId, badgeId: "00000000-0000-4000-8000-000000000001" });
    expect(calls).toEqual({ first: 1, second: 1 });
    const db = await systemDb();
    const [row] = await db.select().from(eventOutbox).where(eq(eventOutbox.name, "badge.awarded"));
    expect(row!.completedHandlers).toContain("test.platform.first");
    expect(row!.completedHandlers).not.toContain("test.platform.second");
    expect(row!.attempts).toBe(1);
    expect(row!.lastError).toContain("second subscriber failed");
    expect(row!.dispatchedAt).toBeNull();
    expect(row!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    expect(await dispatchPendingEvents()).toBe(0); // backoff: not due yet
    failSecond = false;
    await db.update(eventOutbox).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(eventOutbox.id, row!.id));
    expect(await dispatchPendingEvents()).toBe(1);
    expect(calls).toEqual({ first: 1, second: 2 });
    const [after] = await db.select().from(eventOutbox).where(eq(eventOutbox.id, row!.id));
    expect(after!.completedHandlers).toEqual(expect.arrayContaining(["test.platform.first", "test.platform.second"]));
    expect(after!.dispatchedAt).not.toBeNull();
    expect(after!.lastError).toBeNull();
  });

  it("dispatches emitInTx events only after commit, via dispatchPendingEvents", async () => {
    calls.first = 0;
    calls.second = 0;
    const payload = { organizationId: orgId, userId, badgeId: "00000000-0000-4000-8000-000000000001" };
    await withTenant(orgId, (tx) => emitInTx(tx, "badge.awarded", payload));
    // A rolled-back emitInTx leaves nothing behind.
    await expect(
      withTenant(orgId, async (tx) => {
        await emitInTx(tx, "badge.awarded", payload);
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(calls).toEqual({ first: 0, second: 0 });
    expect(await dispatchPendingEvents()).toBe(1);
    expect(calls).toEqual({ first: 1, second: 1 });
    expect(await dispatchPendingEvents()).toBe(0); // dispatched exactly once
    expect(calls).toEqual({ first: 1, second: 1 });
  });
});

describe("readiness and metrics", () => {
  it("reports ready when the database answers", async () => {
    const res = await env.app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ready", checks: { db: "ok", redis: "disabled" } });
  });

  it("hides /metrics unless METRICS_TOKEN is set and matches", async () => {
    expect((await env.app.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(404);
    const original = config.METRICS_TOKEN;
    config.METRICS_TOKEN = "test-metrics-token-123456";
    try {
      expect((await env.app.inject({ method: "GET", url: "/metrics", headers: { authorization: "Bearer wrong" } })).statusCode).toBe(404);
      await env.app.inject({ method: "GET", url: "/api/v1/courses/00000000-0000-4000-8000-000000000009", headers: { host: "localhost" } });
      const res = await env.app.inject({ method: "GET", url: "/metrics", headers: { authorization: "Bearer test-metrics-token-123456" } });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("lms_http_request_duration_seconds_bucket");
      expect(res.body).toContain('route="/api/v1/courses/:courseId"');
      expect(res.body).not.toContain("00000000-0000-4000-8000-000000000009");
      expect(res.body).toMatch(/lms_jobs_queued \d+/);
      expect(res.body).toMatch(/lms_outbox_backlog \d+/);
      expect(res.body).toContain("lms_process_cpu_user_seconds_total");
    } finally {
      config.METRICS_TOKEN = original;
    }
  });
});

describe("plan limits (free plan: 5 courses, 50 users)", () => {
  it("rejects creating courses and users beyond the plan with 402", async () => {
    const admin = new Client(env.app, "acme.localhost");
    expect((await admin.login("admin@acme.test")).status).toBe(200);
    for (let i = 1; i <= 5; i++) {
      expect((await admin.req("POST", "/courses", { fullname: `Course ${i}`, shortname: `C${i}` })).status).toBe(201);
    }
    const over = await admin.req("POST", "/courses", { fullname: "Course 6", shortname: "C6" });
    expect(over.status).toBe(402);
    expect(over.body.error.code).toBe("PLAN_LIMIT");
    expect((await admin.req("GET", "/courses")).body.total).toBe(5);

    const rows = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({ email: `${prefix}${i}@acme.test`, firstName: "U", lastName: String(i) }));
    const tooMany = await admin.req("POST", "/users/import", { rows: rows(50, "x") }); // 1 admin + 50 > 50
    expect(tooMany.status).toBe(402);
    expect((await admin.req("POST", "/users/import", { rows: rows(49, "y") })).body.created).toBe(49);
    const single = await admin.req("POST", "/users", { email: "one-too-many@acme.test", firstName: "N", lastName: "O" });
    expect(single.status).toBe(402);
  });
});
