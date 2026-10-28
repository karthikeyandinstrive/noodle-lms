import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, courseCompletions, eventOutbox, jobs, organizations, systemDb } from "@lms/db";
import { dispatchPendingEvents, emit } from "../../core/events";
import { runDueJobs } from "../../core/jobs";
import { Client, PASSWORD, setup, type TestEnv } from "../../../test/helpers";

/**
 * course.completed → durable jobs (certificate.autoIssue, badges.autoAward) →
 * idempotent issue/award → certificate.issued / badge.awarded via the outbox.
 */
let env: TestEnv;
let admin: Client;
let student: Client;
let studentId: string;
let courseId: string;
let certActivityId: string;
let badgeId: string;

const drain = async () => {
  for (let i = 0; i < 10; i++) {
    const n = (await runDueJobs(50)) + (await dispatchPendingEvents(50));
    if (!n) break;
  }
};

beforeAll(async () => {
  env = await setup();
  admin = new Client(env.app);
  expect((await admin.login("admin@default.test")).status).toBe(200);
  expect((await admin.req("POST", "/users", { email: "zoe@default.test", firstName: "Zoë", lastName: "Ñúñez", password: PASSWORD })).status).toBe(201);
  student = new Client(env.app);
  await student.login("zoe@default.test");
  studentId = (await student.req("GET", "/auth/me")).body.user.id;
  courseId = (await admin.req("POST", "/courses", { fullname: "Ελληνικά", shortname: "GR", selfEnrol: "open" })).body.id;
  const sectionId = (await admin.req("GET", `/courses/${courseId}`)).body.sections[0].id;
  await student.req("POST", `/courses/${courseId}/enrol`, {});

  const template = await admin.req("POST", "/certificates/templates", {
    name: "Default",
    elements: [
      { type: "text", x: 148.5, y: 60, fontSize: 30, align: "center", text: "{{fullname}} — Кириллица" },
      { type: "qrcode", x: 250, y: 160, width: 25 },
    ],
  });
  expect(template.status).toBe(201);
  const act = await admin.req("POST", `/courses/${courseId}/activities`, {
    type: "certificate",
    sectionId,
    name: "Certificate",
    settings: { templateId: template.body.id, requireCourseCompletion: false, autoIssue: true },
  });
  expect(act.status).toBe(201);
  certActivityId = act.body.id;
  const badge = await admin.req("POST", "/badges", { courseId, name: "Finisher", description: "Finished the course", criteria: { type: "course_completion" } });
  expect(badge.status).toBe(201);
  badgeId = badge.body.id;
});

afterAll(async () => {
  await env.app.close();
  await closeDb();
});

describe("auto issue and award on course.completed", () => {
  it("enqueues durable jobs that issue once, even when the event is delivered twice", async () => {
    const orgId = env.orgs.default!.id;
    const payload = { organizationId: orgId, courseId, userId: studentId };
    const db = await systemDb();
    // What the completion module records before it raises course.completed.
    await db.insert(courseCompletions).values({ organizationId: orgId, courseId, userId: studentId });
    await emit("course.completed", payload);
    await emit("course.completed", payload);

    const queued = await db.select().from(jobs).where(eq(jobs.tenantId, orgId));
    // uniqueKey dedupes the second enqueue while the first job is still queued.
    expect(queued.filter((j) => j.name === "certificate.autoIssue")).toHaveLength(1);
    expect(queued.filter((j) => j.name === "badges.autoAward")).toHaveLength(1);

    await drain();
    // A re-delivery after the jobs ran is a no-op too.
    await emit("course.completed", payload);
    await drain();

    const status = await student.req("GET", `/certificates/${certActivityId}/status`);
    expect(status.body.certificate).toMatchObject({ status: "valid", hasFile: true });
    const mine = await student.req("GET", "/certificates/me");
    expect(mine.body).toHaveLength(1);
    const badges = await student.req("GET", "/badges/me");
    expect(badges.body.map((b: { badge: { id: string } }) => b.badge.id)).toEqual([badgeId]);

    const events = await db.select().from(eventOutbox).where(eq(eventOutbox.tenantId, orgId));
    expect(events.filter((e) => e.name === "certificate.issued")).toHaveLength(1);
    expect(events.filter((e) => e.name === "badge.awarded")).toHaveLength(1);
    const done = await db.select().from(jobs).where(eq(jobs.tenantId, orgId));
    expect(done.every((j) => j.status === "done")).toBe(true);

    // Claiming afterwards returns the same certificate.
    const claim = await student.req("POST", `/certificates/${certActivityId}/issue`, {});
    expect(claim.status).toBe(200);
    expect(claim.body.id).toBe(status.body.certificate.id);
  });

  it("keeps APP_URL for Open Badges ids in self-hosted mode, even with a custom domain", async () => {
    const db = await systemDb();
    await db.update(organizations).set({ customDomain: "learn.example.org" }).where(eq(organizations.id, env.orgs.default!.id));
    const issuer = await admin.req("GET", "/badges/issuer");
    expect(issuer.status).toBe(200);
    // Self-hosted test config (SAAS_MODE off) keeps APP_URL.
    expect(issuer.body.id).toMatch(/^http:\/\/localhost:3000\/api\/v1\/badges\/issuer$/);
  });
});
