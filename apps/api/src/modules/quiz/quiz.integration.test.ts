import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "@lms/db";
import { Client, PASSWORD, setup, type TestEnv } from "../../../test/helpers";

/**
 * End-to-end flow over the HTTP API (in-memory PGlite): question bank → quiz →
 * attempt → grading, and assignment submit → grade. Focus on leaks and ownership.
 */
let env: TestEnv;
let admin: Client;
let student: Client;
let other: Client;
let studentId: string;
let courseId: string;
let sectionId: string;

beforeAll(async () => {
  env = await setup();
  admin = new Client(env.app);
  expect((await admin.login("admin@default.test")).status).toBe(200);
  for (const email of ["s1@default.test", "s2@default.test"]) {
    expect((await admin.req("POST", "/users", { email, firstName: "Stu", lastName: email.slice(0, 2), password: PASSWORD })).status).toBe(201);
  }
  student = new Client(env.app);
  const login = await student.login("s1@default.test");
  expect(login.status).toBe(200);
  studentId = (await student.req("GET", "/auth/me")).body.user.id;
  other = new Client(env.app);
  await other.login("s2@default.test");

  const course = await admin.req("POST", "/courses", { fullname: "Geo", shortname: "GEO", selfEnrol: "open" });
  courseId = course.body.id;
  sectionId = (await admin.req("GET", `/courses/${courseId}`)).body.sections[0].id;
  expect((await student.req("POST", `/courses/${courseId}/enrol`, {})).status).toBe(200);
  expect((await other.req("POST", `/courses/${courseId}/enrol`, {})).status).toBe(200);
});

afterAll(async () => {
  await env.app.close();
  await closeDb();
});

describe("question bank + quiz", () => {
  let quizId: string;
  let mcId: string;
  let essayId: string;
  let attemptId: string;

  it("creates categories and versioned questions", async () => {
    const cat = await admin.req("POST", "/question-bank/categories", { courseId, name: "Capitals" });
    expect(cat.status).toBe(201);
    const mc = await admin.req("POST", "/question-bank/questions", {
      categoryId: cat.body.id,
      type: "multichoice",
      name: "France",
      text: "<p>Capital of France?</p>",
      defaultMark: 2,
      data: {
        single: true,
        options: [
          { id: "a", text: "Paris", fraction: 1, feedback: "SECRET-RIGHT" },
          { id: "b", text: "Lyon", fraction: 0, feedback: "" },
        ],
      },
    });
    expect(mc.status).toBe(201);
    mcId = mc.body.id;
    const edited = await admin.req("PUT", `/question-bank/questions/${mcId}`, { ...mc.body.current, type: "multichoice", name: "France v2" });
    expect(edited.status).toBe(200);
    expect(edited.body.latestVersion).toBe(2);
    expect((await admin.req("GET", `/question-bank/questions/${mcId}/versions`)).body).toHaveLength(2);

    const essay = await admin.req("POST", "/question-bank/questions", { categoryId: cat.body.id, type: "essay", name: "Essay", text: "Discuss", data: {} });
    essayId = essay.body.id;
    const list = await admin.req("GET", `/question-bank/categories/${cat.body.id}/questions`);
    expect(list.body.total).toBe(2);
    // Students cannot see the bank.
    expect((await student.req("GET", `/question-bank/questions/${mcId}`)).status).toBe(404);
    // Invalid data is rejected.
    const bad = await admin.req("POST", "/question-bank/questions", { categoryId: cat.body.id, type: "truefalse", name: "x", text: "x", data: {} });
    expect(bad.status).toBe(400);
  });

  it("creates a quiz and adds slots", async () => {
    const res = await admin.req("POST", `/courses/${courseId}/activities`, {
      type: "quiz",
      sectionId,
      name: "Quiz 1",
      settings: { attemptsAllowed: 2, gradeMax: 10, timeLimitSeconds: 600 },
    });
    expect(res.status).toBe(201);
    quizId = res.body.id;
    const slots = await admin.req("POST", `/quizzes/${quizId}/slots`, { questionIds: [mcId, essayId] });
    expect(slots.status).toBe(200);
    expect(slots.body.map((s: { maxMark: number }) => s.maxMark)).toEqual([2, 1]);
    expect((await student.req("POST", `/quizzes/${quizId}/slots`, { questionIds: [mcId] })).status).toBe(403);
  });

  it("never leaks answers during an attempt", async () => {
    const start = await student.req("POST", `/quizzes/${quizId}/attempts`, {});
    expect(start.status).toBe(200);
    expect(start.body.preview).toBe(false);
    attemptId = start.body.attemptId;
    const again = await student.req("POST", `/quizzes/${quizId}/attempts`, {});
    expect(again.body).toMatchObject({ attemptId, resumed: true });

    const view = await student.req("GET", `/quizzes/${quizId}/attempts/${attemptId}`);
    expect(view.status).toBe(200);
    const json = JSON.stringify(view.body);
    expect(json).not.toMatch(/fraction|SECRET-RIGHT|France v2|"rightAnswer":"|"state"|"mark"|"grade"/);
    expect(view.body.attempt.dueAt).toBeTruthy();
    // Another student can't see it.
    expect((await other.req("GET", `/quizzes/${quizId}/attempts/${attemptId}`)).status).toBe(404);
  });

  it("saves, finishes and grades; essay needs manual grading", async () => {
    const view = await student.req("GET", `/quizzes/${quizId}/attempts/${attemptId}`);
    const [q1, q2] = view.body.questions;
    expect((await other.req("PUT", `/quizzes/${quizId}/attempts/${attemptId}/responses`, { responses: [] })).status).toBe(404);
    const bad = await student.req("PUT", `/quizzes/${quizId}/attempts/${attemptId}/responses`, {
      responses: [{ slotId: q1.slotId, response: { selected: "a" } }],
    });
    expect(bad.status).toBe(400);
    const save = await student.req("PUT", `/quizzes/${quizId}/attempts/${attemptId}/responses`, {
      responses: [
        { slotId: q1.slotId, response: { selected: ["a"] } },
        { slotId: q2.slotId, response: { text: "Paris is lovely" } },
      ],
    });
    expect(save.status).toBe(200);
    const fin = await student.req("POST", `/quizzes/${quizId}/attempts/${attemptId}/finish`, {});
    expect(fin.status).toBe(200);
    expect(fin.body).toMatchObject({ status: "finished", needsGrading: true, grade: null, sumMarks: 2 });

    const review = await student.req("GET", `/quizzes/${quizId}/attempts/${attemptId}`);
    expect(review.body.questions[0]).toMatchObject({ state: "correct", mark: 2, feedback: "SECRET-RIGHT" });
    expect(review.body.questions[0].rightAnswer).toBeUndefined(); // default reviewOptions.rightAnswer=false
    expect(review.body.questions[1].state).toBe("needs_grading");

    const slotId = review.body.questions[1].slotId;
    expect((await student.req("POST", `/quizzes/${quizId}/attempts/${attemptId}/slots/${slotId}/grade`, { mark: 1 })).status).toBe(403);
    expect((await admin.req("POST", `/quizzes/${quizId}/attempts/${attemptId}/slots/${slotId}/grade`, { mark: 5 })).status).toBe(400);
    const g = await admin.req("POST", `/quizzes/${quizId}/attempts/${attemptId}/slots/${slotId}/grade`, { mark: 0.5, comment: "ok" });
    expect(g.status).toBe(200);

    const summary = await student.req("GET", `/quizzes/${quizId}`);
    expect(summary.body.myGrade).toBeCloseTo((2.5 / 3) * 10, 3);
    expect(summary.body.canStart).toBe(true);

    const report = await admin.req("GET", `/quizzes/${quizId}/results`);
    expect(report.status).toBe(200);
    expect(report.body.attempts).toHaveLength(1);
    expect(report.body.questions[0].facility).toBe(1);
    expect((await student.req("GET", `/quizzes/${quizId}/results`)).status).toBe(403);

    const grades = await admin.req("GET", `/courses/${courseId}/grades`);
    if (grades.status === 200) expect(JSON.stringify(grades.body)).toContain("8.33333");
  });

  it("locks structure after attempts; admin preview is not counted", async () => {
    expect((await admin.req("POST", `/quizzes/${quizId}/slots`, { questionIds: [mcId] })).status).toBe(409);
    const p = await admin.req("POST", `/quizzes/${quizId}/attempts`, {});
    expect(p.body.preview).toBe(true);
    await admin.req("POST", `/quizzes/${quizId}/attempts/${p.body.attemptId}/finish`, {});
    const report = await admin.req("GET", `/quizzes/${quizId}/results`);
    expect(report.body.attempts).toHaveLength(1);
  });

  it("enforces the attempt limit", async () => {
    const a2 = await student.req("POST", `/quizzes/${quizId}/attempts`, {});
    expect(a2.status).toBe(200);
    await student.req("POST", `/quizzes/${quizId}/attempts/${a2.body.attemptId}/finish`, {});
    expect((await student.req("POST", `/quizzes/${quizId}/attempts`, {})).status).toBe(409);
    const s = await student.req("GET", `/quizzes/${quizId}`);
    expect(s.body.canStart).toBe(false);
  });
});

describe("assignment", () => {
  let asgId: string;

  it("draft → submit → grade → feedback", async () => {
    const res = await admin.req("POST", `/courses/${courseId}/activities`, {
      type: "assignment",
      sectionId,
      name: "Essay",
      settings: { allowFiles: false, gradeMax: 20, dueAt: new Date(Date.now() - 3600_000).toISOString() },
    });
    expect(res.status).toBe(201);
    asgId = res.body.id;
    expect((await student.req("POST", `/assignments/${asgId}/submit`, {})).status).toBe(400);
    const draft = await student.req("PUT", `/assignments/${asgId}/draft`, { text: "<script>x</script>My work", fileIds: [] });
    expect(draft.status).toBe(200);
    expect(draft.body.text).not.toContain("<script>");
    expect((await student.req("PUT", `/assignments/${asgId}/draft`, { text: "x", fileIds: ["00000000-0000-0000-0000-000000000000"] })).status).toBe(400);
    const sub = await student.req("POST", `/assignments/${asgId}/submit`, {});
    expect(sub.status).toBe(200);
    expect(sub.body).toMatchObject({ status: "submitted", late: true });

    const list = await admin.req("GET", `/assignments/${asgId}/submissions`);
    expect(list.status).toBe(200);
    expect(list.body.counts).toMatchObject({ participants: 2, submitted: 1, needsGrading: 1 });
    expect((await student.req("GET", `/assignments/${asgId}/submissions`)).status).toBe(403);
    expect((await other.req("GET", `/assignments/${asgId}/submissions/${studentId}`)).status).toBe(404);

    expect((await admin.req("POST", `/assignments/${asgId}/submissions/${studentId}/grade`, { grade: 25 })).status).toBe(400);
    const g = await admin.req("POST", `/assignments/${asgId}/submissions/${studentId}/grade`, { grade: 15, feedback: "<p>Good</p>" });
    expect(g.status).toBe(200);
    const me = await student.req("GET", `/assignments/${asgId}/me`);
    expect(me.body.feedback).toMatchObject({ grade: 15 });
    expect(me.body.canEdit).toBe(false);

    const reopen = await admin.req("POST", `/assignments/${asgId}/submissions/${studentId}/reopen`, {});
    expect(reopen.body).toMatchObject({ attempt: 2, status: "reopened" });
    const me2 = await student.req("GET", `/assignments/${asgId}/me`);
    expect(me2.body.canEdit).toBe(true);
    expect(me2.body.submission.text).toContain("My work");
  });

  it("blind marking hides names", async () => {
    await admin.req("PATCH", `/activities/${asgId}`, { settings: { blindMarking: true } });
    const list = await admin.req("GET", `/assignments/${asgId}/submissions`);
    expect(JSON.stringify(list.body)).not.toContain("s1@default.test");
    expect(list.body.items[0].displayName).toMatch(/^Participant \d+$/);
  });
});
