/**
 * Scheduler tasks and the /admin/system API (in-memory database).
 */
import { and, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authTokens, closeDb, eventOutbox, jobs, quizAttempts, scheduledTaskRuns, systemDb, users } from "@lms/db";
import { dispatchPendingEvents } from "../../core/events";
import { defineJob, enqueueJob, runDueJobs } from "../../core/jobs";
import { Client, PASSWORD, setup, type TestEnv } from "../../../test/helpers";
import { autoFinishOverdueAttempts, claimTask, cleanup, runTask, scheduledTasks, taskNamed } from "./tasks";

let env: TestEnv;
let admin: Client;
let student: Client;
let studentId: string;
let courseId: string;
let sectionId: string;

const orgId = () => env.orgs.default!.id;
const drainJobs = async () => {
  while ((await runDueJobs(50)) > 0);
};

beforeAll(async () => {
  env = await setup();
  admin = new Client(env.app);
  expect((await admin.login("admin@default.test")).status).toBe(200);
  const created = await admin.req("POST", "/users", { email: "sched@default.test", firstName: "Sam", lastName: "Student", password: PASSWORD });
  expect(created.status).toBe(201);
  studentId = created.body.id;
  student = new Client(env.app);
  expect((await student.login("sched@default.test")).status).toBe(200);
  const course = await admin.req("POST", "/courses", { fullname: "Scheduling", shortname: "SCH" });
  courseId = course.body.id;
  expect((await admin.req("POST", `/courses/${courseId}/enrolments`, { userIds: [studentId] })).status).toBe(200);
  sectionId = (await admin.req("GET", `/courses/${courseId}`)).body.sections[0].id;
  await drainJobs(); // invitation emails etc.
});

afterAll(async () => {
  await env.app.close();
  await closeDb();
});

describe("task lock", () => {
  it("runs a task once per interval and never while another replica holds it", async () => {
    const t0 = new Date("2030-01-01T00:00:00Z");
    expect(await claimTask("test_task", 60_000, t0)).toBe(true); // first claim inserts the row
    expect(await claimTask("test_task", 60_000, new Date(t0.getTime() + 120_000))).toBe(false); // due but locked
    expect(await claimTask("test_task", 60_000, t0, true)).toBe(false); // force still respects the lock
    const db = await systemDb();
    await db.update(scheduledTaskRuns).set({ lockedUntil: null }).where(eq(scheduledTaskRuns.name, "test_task"));
    expect(await claimTask("test_task", 60_000, new Date(t0.getTime() + 30_000))).toBe(false); // not due yet
    expect(await claimTask("test_task", 60_000, new Date(t0.getTime() + 61_000))).toBe(true);
  });

  it("records the last run of every scheduled task", async () => {
    for (const task of scheduledTasks) expect(await runTask(task, { force: true })).toBe(true);
    const db = await systemDb();
    const runs = await db.select().from(scheduledTaskRuns);
    for (const task of scheduledTasks) {
      const run = runs.find((r) => r.name === task.name);
      expect(run?.lastRunAt).toBeTruthy();
      expect(run?.lockedUntil).toBeNull();
    }
    // Not due again right away.
    expect(await runTask(taskNamed("cleanup")!)).toBe(false);
  });
});

describe("due-soon reminders", () => {
  let assignmentId: string;

  it("reminds students once about an unsubmitted assignment due within 24h", async () => {
    const a = await admin.req("POST", `/courses/${courseId}/activities`, {
      type: "assignment",
      sectionId,
      name: "Lab report",
      settings: { allowFiles: false, gradeMax: 10, dueAt: new Date(Date.now() + 6 * 3600_000).toISOString() },
    });
    expect(a.status).toBe(201);
    assignmentId = a.body.id;
    const m = await admin.req("POST", `/courses/${courseId}/activities`, {
      type: "video",
      sectionId,
      name: "Live class",
      settings: { startsAt: new Date(Date.now() + 30 * 60_000).toISOString() },
    });
    expect(m.status).toBe(201);

    const task = taskNamed("due_soon_reminders")!;
    const db = await systemDb();
    await db.update(scheduledTaskRuns).set({ lastRunAt: new Date(0), lockedUntil: null }).where(eq(scheduledTaskRuns.name, task.name));
    expect(await runTask(task)).toBe(true);
    await db.update(scheduledTaskRuns).set({ lastRunAt: new Date(0), lockedUntil: null }).where(eq(scheduledTaskRuns.name, task.name));
    expect(await runTask(task)).toBe(true); // second run: deduplicated
    await drainJobs();

    const reminders = await db.select().from(jobs).where(like(jobs.uniqueKey, `due_soon:%:${studentId}`));
    expect(reminders.map((j) => j.uniqueKey!.split(":")[1]).sort()).toEqual(["assignment", "video"]);
    expect(reminders.every((j) => j.status === "done" && j.tenantId === orgId())).toBe(true);

    const list = await student.req("GET", "/notifications?unread=true");
    const types = list.body.items.map((n: { type: string; link: string }) => `${n.type}:${n.link}`);
    expect(types).toContain(`due_soon:/activities/${assignmentId}`);
    expect(types).toContain(`video_meeting:/activities/${m.body.id}`);
    expect(types.filter((t: string) => t === `due_soon:/activities/${assignmentId}`)).toHaveLength(1);
    // The teacher (not a student) gets no assignment reminder.
    const adminList = await admin.req("GET", "/notifications?unread=true");
    expect(adminList.body.items.some((n: { type: string }) => n.type === "due_soon")).toBe(false);
  });

  it("skips students who already submitted", async () => {
    // Move the deadline (new reminder key) after the student submitted.
    expect((await student.req("PUT", `/assignments/${assignmentId}/draft`, { text: "done" })).status).toBe(200);
    expect((await student.req("POST", `/assignments/${assignmentId}/submit`, {})).status).toBe(200);
    expect(
      (await admin.req("PATCH", `/activities/${assignmentId}`, { settings: { dueAt: new Date(Date.now() + 8 * 3600_000).toISOString() } })).status,
    ).toBe(200);
    const db = await systemDb();
    const before = (await db.select().from(jobs).where(like(jobs.uniqueKey, `due_soon:assignment:${assignmentId}:%`))).length;
    await db.update(scheduledTaskRuns).set({ lastRunAt: new Date(0), lockedUntil: null }).where(eq(scheduledTaskRuns.name, "due_soon_reminders"));
    await runTask(taskNamed("due_soon_reminders")!);
    expect((await db.select().from(jobs).where(like(jobs.uniqueKey, `due_soon:assignment:${assignmentId}:%`))).length).toBe(before);
  });
});

describe("quiz auto-finish", () => {
  it("finishes overdue in-progress attempts and emits the completion events", async () => {
    const cat = await admin.req("POST", "/question-bank/categories", { courseId, name: "Q" });
    const q = await admin.req("POST", "/question-bank/questions", { categoryId: cat.body.id, type: "essay", name: "E", text: "Discuss", data: {} });
    expect(q.status).toBe(201);
    const quiz = await admin.req("POST", `/courses/${courseId}/activities`, {
      type: "quiz",
      sectionId,
      name: "Timed",
      completionRule: "submit",
      settings: { timeLimitSeconds: 60 },
    });
    expect(quiz.status).toBe(201);
    expect((await admin.req("POST", `/quizzes/${quiz.body.id}/slots`, { questionIds: [q.body.id] })).status).toBe(200);
    const start = await student.req("POST", `/quizzes/${quiz.body.id}/attempts`, {});
    expect(start.status).toBe(200);

    const db = await systemDb();
    expect(await autoFinishOverdueAttempts()).toBe(0); // not overdue yet
    await db.update(quizAttempts).set({ dueAt: new Date(Date.now() - 10 * 60_000) }).where(eq(quizAttempts.id, start.body.attemptId));
    expect(await autoFinishOverdueAttempts()).toBe(1);
    const [attempt] = await db.select().from(quizAttempts).where(eq(quizAttempts.id, start.body.attemptId));
    expect(attempt!.status).toBe("finished");
    const events = await db.select().from(eventOutbox).where(eq(eventOutbox.tenantId, orgId()));
    expect(events.map((e) => e.name)).toEqual(expect.arrayContaining(["quiz.attempt_submitted", "activity.submitted"]));

    while ((await dispatchPendingEvents(50)) > 0);
    const me = await student.req("GET", `/completion/courses/${courseId}/me`);
    expect(me.body.activities.find((a: { id: string }) => a.id === quiz.body.id).state).toBe("complete");
  });
});

describe("cleanup", () => {
  it("removes used and expired auth tokens", async () => {
    const db = await systemDb();
    const [u] = await db.select().from(users).where(eq(users.id, studentId));
    await db.insert(authTokens).values([
      { organizationId: u!.organizationId, userId: studentId, purpose: "password_reset", tokenHash: "old-token", expiresAt: new Date(Date.now() - 1000) },
      { organizationId: u!.organizationId, userId: studentId, purpose: "password_reset", tokenHash: "live-token", expiresAt: new Date(Date.now() + 3600_000) },
    ]);
    await cleanup();
    const left = (await db.select().from(authTokens).where(eq(authTokens.userId, studentId))).map((t) => t.tokenHash);
    expect(left).toContain("live-token");
    expect(left).not.toContain("old-token");
  });
});

describe("/admin/system API", () => {
  let failedJobId: string;

  beforeAll(async () => {
    defineJob("test.sched_fail", async () => {
      throw new Error("boom");
    });
    failedJobId = await enqueueJob(null, "test.sched_fail", {}, { tenantId: orgId(), maxAttempts: 1 });
    await enqueueJob(null, "test.sched_fail", {}, { tenantId: env.orgs.acme!.id, maxAttempts: 1 }); // other tenant
    await drainJobs();
  });

  it("requires site:view_system", async () => {
    for (const path of ["/admin/system/health", "/admin/system/jobs", "/admin/system/failed-events"]) {
      expect((await student.req("GET", path)).status).toBe(403);
    }
    expect((await student.req("POST", `/admin/system/jobs/${failedJobId}/retry`)).status).toBe(403);
  });

  it("reports health", async () => {
    const res = await admin.req("GET", "/admin/system/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ db: "ok", redis: "disabled" });
    expect(res.body.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(res.body.queue.failedJobs).toBeGreaterThanOrEqual(1);
    expect(res.body.tasks.map((t: { name: string }) => t.name)).toEqual(scheduledTasks.map((t) => t.name));
    expect(res.body.tasks.every((t: { lastRunAt: string | null }) => t.lastRunAt)).toBe(true);
  });

  it("lists only this organization's jobs, without payloads, and retries failed ones", async () => {
    const list = await admin.req("GET", "/admin/system/jobs?status=failed");
    expect(list.status).toBe(200);
    expect(list.body.items.map((j: { id: string }) => j.id)).toEqual([failedJobId]);
    expect(list.body.items[0].lastError).toContain("boom");
    expect(list.body.items[0].payload).toBeUndefined();

    const retry = await admin.req("POST", `/admin/system/jobs/${failedJobId}/retry`);
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ status: "queued", attempts: 0 });
    expect((await admin.req("POST", `/admin/system/jobs/${failedJobId}/retry`)).status).toBe(409);

    const acme = await (await systemDb()).select().from(jobs).where(and(eq(jobs.name, "test.sched_fail"), eq(jobs.tenantId, env.orgs.acme!.id)));
    expect((await admin.req("POST", `/admin/system/jobs/${acme[0]!.id}/retry`)).status).toBe(404);

    expect((await admin.req("DELETE", `/admin/system/jobs/${failedJobId}`)).status).toBe(200);
    expect((await admin.req("GET", "/admin/system/jobs?name=test.sched_fail")).body.total).toBe(0);
  });

  it("lists and retries failed events", async () => {
    const db = await systemDb();
    const [row] = await db
      .insert(eventOutbox)
      .values({ tenantId: orgId(), name: "badge.awarded", payload: { organizationId: orgId(), badgeId: studentId, userId: studentId }, attempts: 8, lastError: "GAVE UP: x", dispatchedAt: new Date() })
      .returning();
    const list = await admin.req("GET", "/admin/system/failed-events");
    expect(list.status).toBe(200);
    expect(list.body.items.find((e: { id: string }) => e.id === row!.id)).toMatchObject({ gaveUp: true, attempts: 8 });
    expect((await admin.req("POST", `/admin/system/failed-events/${row!.id}/retry`)).status).toBe(200);
    const [after] = await db.select().from(eventOutbox).where(eq(eventOutbox.id, row!.id));
    expect(after).toMatchObject({ attempts: 0, dispatchedAt: null });
  });
});
