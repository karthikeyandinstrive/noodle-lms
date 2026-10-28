/**
 * End-to-end flow across gradebook, completion, notifications, calendar and reports
 * (in-memory database, see vitest.config.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "@lms/db";
import { dispatchPendingEvents } from "../../core/events";
import { Client, PASSWORD, setup, type TestEnv } from "../../../test/helpers";

let env: TestEnv;
let admin: Client;
let student: Client;
let studentId: string;
let courseId: string;
let viewPageId: string;
let manualPageId: string;

/** Dispatches outbox events (emitInTx follow-ups) the way the worker would. */
const settle = async () => {
  while ((await dispatchPendingEvents(50)) > 0);
};

beforeAll(async () => {
  env = await setup();
  admin = new Client(env.app);
  expect((await admin.login("admin@default.test")).status).toBe(200);
  const created = await admin.req("POST", "/users", { email: "flow@default.test", firstName: "Stu", lastName: "Dent", password: PASSWORD });
  expect(created.status).toBe(201);
  studentId = created.body.id;
  student = new Client(env.app);
  expect((await student.login("flow@default.test")).status).toBe(200);

  const course = await admin.req("POST", "/courses", { fullname: "Biology", shortname: "BIO" });
  expect(course.status).toBe(201);
  courseId = course.body.id;
  expect((await admin.req("POST", `/courses/${courseId}/enrolments`, { userIds: [studentId] })).status).toBe(200);
  const overview = await admin.req("GET", `/courses/${courseId}`);
  const sectionId = overview.body.sections[0].id;
  const a = await admin.req("POST", `/courses/${courseId}/activities`, { sectionId, name: "Read me", type: "page", completionRule: "view", settings: { content: "<p>Hi</p>" } });
  expect(a.status).toBe(201);
  viewPageId = a.body.id;
  const b = await admin.req("POST", `/courses/${courseId}/activities`, { sectionId, name: "Tick me", type: "page", completionRule: "manual", settings: { content: "<p>Hi</p>" } });
  expect(b.status).toBe(201);
  manualPageId = b.body.id;
});

afterAll(async () => {
  await env.app.close();
  await closeDb();
});

describe("completion", () => {
  it("completes a view-rule activity when viewed", async () => {
    expect((await student.req("GET", `/activities/${viewPageId}`)).status).toBe(200);
    await settle();
    const me = await student.req("GET", `/completion/courses/${courseId}/me`);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ total: 2, completed: 1, percentage: 50, completedAt: null });
  });

  it("rejects manual completion of a non-manual activity", async () => {
    const res = await student.req("POST", `/completion/activities/${viewPageId}/manual`, { completed: true });
    expect(res.status).toBe(400);
  });

  it("completes the course after the last manual activity and notifies", async () => {
    const res = await student.req("POST", `/completion/activities/${manualPageId}/manual`, { completed: true });
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("complete");
    const me = await student.req("GET", `/completion/courses/${courseId}/me`);
    expect(me.body.percentage).toBe(100);
    expect(me.body.completedAt).not.toBeNull();
    const list = await student.req("GET", "/notifications?unread=true");
    expect(list.body.items.some((n: { type: string }) => n.type === "course_completed")).toBe(true);
  });

  it("shows the completion matrix to teachers only", async () => {
    expect((await student.req("GET", `/completion/courses/${courseId}`)).status).toBe(403);
    const report = await admin.req("GET", `/completion/courses/${courseId}`);
    expect(report.status).toBe(200);
    expect(report.body.users.items[0]).toMatchObject({ id: studentId, progress: 100 });
    expect(report.body.states).toHaveLength(2);
  });

  it("lets a teacher override completion (audited)", async () => {
    const res = await admin.req("POST", `/completion/activities/${viewPageId}/users/${studentId}/override`, { state: "incomplete" });
    expect(res.status).toBe(200);
    // An automatic view no longer changes the overridden state.
    await student.req("GET", `/activities/${viewPageId}`);
    await settle();
    const me = await student.req("GET", `/completion/courses/${courseId}/me`);
    expect(me.body.completed).toBe(1);
  });
});

describe("gradebook", () => {
  let hwId: string;
  let examId: string;

  it("aggregates manual items through categories into the course total", async () => {
    const cat = await admin.req("POST", `/grades/courses/${courseId}/categories`, { name: "Homework", aggregation: "mean" });
    expect(cat.status).toBe(201);
    const hw = await admin.req("POST", `/grades/courses/${courseId}/items`, { name: "HW 1", gradeMax: 10, categoryId: cat.body.id });
    expect(hw.status).toBe(201);
    hwId = hw.body.id;
    const exam = await admin.req("POST", `/grades/courses/${courseId}/items`, { name: "Exam", gradeMax: 20 });
    examId = exam.body.id;

    const g1 = await admin.req("PUT", `/grades/items/${hwId}/users/${studentId}`, { finalGrade: 5, feedback: "<b>ok</b><script>x</script>" });
    expect(g1.status).toBe(200);
    expect(g1.body.grade).toMatchObject({ finalGrade: 5, overridden: true });
    expect(g1.body.grade.feedback).not.toContain("script");
    expect(g1.body.courseTotal).toBe(50);
    const g2 = await admin.req("PUT", `/grades/items/${examId}/users/${studentId}`, { finalGrade: 20 });
    expect(g2.body.courseTotal).toBe(75); // (50% + 100%) / 2

    const outOfRange = await admin.req("PUT", `/grades/items/${examId}/users/${studentId}`, { finalGrade: 21 });
    expect(outOfRange.status).toBe(400);
  });

  it("recalculates when weights change", async () => {
    const setup = await admin.req("GET", `/grades/courses/${courseId}/setup`);
    const hwCat = setup.body.categories.find((c: { name: string }) => c.name === "Homework");
    expect((await admin.req("PATCH", `/grades/categories/${hwCat.id}`, { weight: 3 })).status).toBe(200);
    const report = await student.req("GET", `/grades/courses/${courseId}/me`);
    expect(report.status).toBe(200);
    expect(report.body.courseTotal.percentage).toBe(62.5); // (50*3 + 100) / 4
  });

  it("hides hidden items from the user report", async () => {
    expect((await admin.req("PATCH", `/grades/items/${examId}`, { hidden: true })).status).toBe(200);
    const report = await student.req("GET", `/grades/courses/${courseId}/me`);
    expect(report.body.items.map((i: { name: string }) => i.name)).not.toContain("Exam");
    const teacher = await admin.req("GET", `/grades/courses/${courseId}/users/${studentId}`);
    expect(teacher.body.items.map((i: { name: string }) => i.name)).toContain("Exam");
  });

  it("protects the grader report, overrides and history", async () => {
    expect((await student.req("GET", `/grades/courses/${courseId}`)).status).toBe(403);
    expect((await student.req("PUT", `/grades/items/${hwId}/users/${studentId}`, { finalGrade: 10 })).status).toBe(404);
    const grader = await admin.req("GET", `/grades/courses/${courseId}`);
    expect(grader.status).toBe(200);
    expect(grader.body.users.total).toBe(1);
    expect(grader.body.items.at(-1).type).toBe("course");
    const own = await student.req("GET", `/grades/items/${hwId}/users/${studentId}/history`);
    expect(own.status).toBe(200);
    expect(own.body[0]).toMatchObject({ newGrade: 5, source: "override" });
    expect((await student.req("GET", `/grades/items/${examId}/users/${studentId}/history`)).status).toBe(404);
  });

  it("lists my course totals and exports CSV", async () => {
    const mine = await student.req("GET", "/grades/me");
    expect(mine.body.find((r: { course: { id: string } }) => r.course.id === courseId).percentage).toBe(62.5);
    const csv = await env.app.inject({ method: "GET", url: `/api/v1/grades/courses/${courseId}/export.csv`, headers: { host: "localhost", cookie: admin.cookie } });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.headers["content-disposition"]).toContain("attachment");
    expect(csv.body).toContain("Stu,Dent");
  });

  it("refuses to change locked items", async () => {
    await admin.req("PATCH", `/grades/items/${hwId}`, { locked: true });
    expect((await admin.req("PUT", `/grades/items/${hwId}/users/${studentId}`, { finalGrade: 1 })).status).toBe(409);
  });
});

describe("notifications", () => {
  it("counts, marks read and stores preferences", async () => {
    expect((await student.req("GET", "/notifications/unread-count")).body.count).toBeGreaterThan(0);
    expect((await student.req("POST", "/notifications/read", { all: true })).status).toBe(200);
    expect((await student.req("GET", "/notifications/unread-count")).body.count).toBe(0);
    const put = await student.req("PUT", "/notifications/preferences", { preferences: [{ type: "announcement", inApp: false, email: false }] });
    expect(put.status).toBe(200);
    expect(put.body.find((p: { type: string }) => p.type === "announcement")).toMatchObject({ inApp: false, email: false });
  });

  it("announces to participants, respecting preferences and permissions", async () => {
    expect((await student.req("POST", `/notifications/courses/${courseId}/announce`, { title: "Hi" })).status).toBe(403);
    const res = await admin.req("POST", `/notifications/courses/${courseId}/announce`, { title: "Exam moved", body: "Now Friday" });
    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(1);
    expect((await student.req("GET", "/notifications/unread-count")).body.count).toBe(0); // in-app disabled
  });
});

describe("calendar", () => {
  const from = new Date(Date.now() - 86_400_000).toISOString();
  const to = new Date(Date.now() + 30 * 86_400_000).toISOString();

  it("combines site, course, user events and deadlines", async () => {
    const soon = new Date(Date.now() + 3 * 86_400_000).toISOString();
    expect((await admin.req("POST", "/calendar/events", { type: "site", name: "Holiday", startsAt: soon })).status).toBe(201);
    expect((await admin.req("POST", "/calendar/events", { type: "course", courseId, name: "Lab", startsAt: soon, durationMinutes: 60 })).status).toBe(201);
    expect((await student.req("POST", "/calendar/events", { type: "user", name: "Study", startsAt: soon })).status).toBe(201);
    expect((await student.req("POST", "/calendar/events", { type: "site", name: "Nope", startsAt: soon })).status).toBe(403);
    await admin.req("PATCH", `/activities/${manualPageId}`, { availableUntil: soon });

    const res = await student.req("GET", `/calendar/events?from=${from}&to=${to}`);
    expect(res.status).toBe(200);
    const names = res.body.map((e: { name: string }) => e.name);
    expect(names).toEqual(expect.arrayContaining(["Holiday", "Lab", "Study", "Tick me is due"]));
    const holiday = res.body.find((e: { name: string }) => e.name === "Holiday");
    expect(holiday.editable).toBe(false);
    expect((await student.req("DELETE", `/calendar/events/${holiday.id}`)).status).toBe(403);

    const upcoming = await student.req("GET", "/calendar/upcoming");
    expect(upcoming.body.length).toBeGreaterThanOrEqual(4);
  });

  it("does not expose other users' personal events", async () => {
    const res = await admin.req("GET", `/calendar/events?from=${from}&to=${to}`);
    expect(res.body.map((e: { name: string }) => e.name)).not.toContain("Study");
  });

  it("exports iCal", async () => {
    const res = await env.app.inject({ method: "GET", url: "/api/v1/calendar/export.ics", headers: { host: "localhost", cookie: student.cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/calendar");
    expect(res.body).toContain("BEGIN:VCALENDAR");
    expect(res.body).toContain("SUMMARY:Study");
  });
});

describe("reports", () => {
  it("course overview, participation, logs and outline", async () => {
    const overview = await admin.req("GET", `/reports/courses/${courseId}/overview`);
    expect(overview.status).toBe(200);
    expect(overview.body.activeUsersByDay).toHaveLength(30);
    expect(overview.body.activities.find((a: { id: string }) => a.id === viewPageId).views).toBeGreaterThanOrEqual(2);

    const part = await admin.req("GET", `/reports/courses/${courseId}/participation?activityId=${viewPageId}`);
    expect(part.status).toBe(200);
    expect(part.body.items[0]).toMatchObject({ views: 2 });

    const logs = await admin.req("GET", `/reports/courses/${courseId}/logs?pageSize=5`);
    expect(logs.status).toBe(200);
    expect(logs.body.items.length).toBeGreaterThan(0);
    expect(logs.body.eventNames).toContain("activity.viewed");

    expect((await student.req("GET", `/reports/courses/${courseId}/logs`)).status).toBe(403);
    const outline = await student.req("GET", `/reports/courses/${courseId}/users/${studentId}/outline`);
    expect(outline.status).toBe(200);
    expect(outline.body.activities).toHaveLength(2);
  });

  it("site overview requires report:view_site", async () => {
    expect((await student.req("GET", "/reports/site")).status).toBe(403);
    const site = await admin.req("GET", "/reports/site");
    expect(site.status).toBe(200);
    expect(site.body.users).toBeGreaterThanOrEqual(2);
    expect(site.body.completions).toBe(1);
    expect(site.body.topCourses[0].shortname).toBe("BIO");
  });
});

describe("completion re-evaluation", () => {
  let course2: string;
  const acts: Record<string, string> = {};

  beforeAll(async () => {
    const c = await admin.req("POST", "/courses", { fullname: "Chemistry", shortname: "CHEM" });
    expect(c.status).toBe(201);
    course2 = c.body.id;
    expect((await admin.req("POST", `/courses/${course2}/enrolments`, { userIds: [studentId] })).status).toBe(200);
    const sectionId = (await admin.req("GET", `/courses/${course2}`)).body.sections[0].id;
    for (const name of ["A", "B", "C"]) {
      const res = await admin.req("POST", `/courses/${course2}/activities`, { sectionId, name, type: "page", completionRule: "manual", settings: { content: "<p>x</p>" } });
      expect(res.status).toBe(201);
      acts[name] = res.body.id;
    }
    expect((await student.req("POST", `/completion/activities/${acts.A}/manual`, { completed: true })).status).toBe(200);
    expect((await student.req("GET", `/activities/${acts.B}`)).status).toBe(200); // view recorded, rule is manual
    await settle();
  });

  const mine = async () => (await student.req("GET", `/completion/courses/${course2}/me`)).body;

  it("re-derives states from recorded views when a rule changes to view", async () => {
    expect(await mine()).toMatchObject({ total: 3, completed: 1, completedAt: null });
    expect((await admin.req("PATCH", `/activities/${acts.B}`, { completionRule: "view" })).status).toBe(200);
    await settle();
    expect(await mine()).toMatchObject({ total: 3, completed: 2, completedAt: null });
  });

  it("completes the course when the last incomplete activity is hidden", async () => {
    expect((await admin.req("PATCH", `/activities/${acts.C}`, { visible: false })).status).toBe(200);
    await settle();
    const me = await mine();
    expect(me).toMatchObject({ total: 2, completed: 2, percentage: 100 });
    expect(me.completedAt).not.toBeNull();
    const list = await student.req("GET", "/notifications?unread=true");
    expect(list.body.items.filter((n: { type: string; link: string }) => n.type === "course_completed" && n.link === `/courses/${course2}`)).toHaveLength(1);
  });

  it("keeps the recorded course completion when the activity is shown again or deleted", async () => {
    expect((await admin.req("PATCH", `/activities/${acts.C}`, { visible: true })).status).toBe(200);
    await settle();
    let me = await mine();
    expect(me.total).toBe(3);
    expect(me.completedAt).not.toBeNull();
    expect((await admin.req("DELETE", `/activities/${acts.A}`)).status).toBe(200);
    await settle();
    me = await mine();
    expect(me.total).toBe(2);
    expect(me.completedAt).not.toBeNull();
  });
});
