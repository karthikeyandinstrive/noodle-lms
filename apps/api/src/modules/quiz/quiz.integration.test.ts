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

describe("random slots, calculated and gap select questions", () => {
  let poolId: string;
  let subId: string;
  let calcId: string;

  async function question(categoryId: string, body: Record<string, unknown>) {
    const res = await admin.req("POST", "/question-bank/questions", { categoryId, ...body });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as string;
  }
  async function quiz(name: string) {
    const res = await admin.req("POST", `/courses/${courseId}/activities`, { type: "quiz", sectionId, name, settings: { attemptsAllowed: 0, gradeMax: 10 } });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  it("builds a bank with the new question types", async () => {
    poolId = (await admin.req("POST", "/question-bank/categories", { courseId, name: "Pool" })).body.id;
    subId = (await admin.req("POST", "/question-bank/categories", { courseId, name: "Sub", parentId: poolId })).body.id;
    calcId = await question(poolId, {
      type: "calculated",
      name: "Area",
      text: "<p>Area of a {w} by {h} rectangle?</p>",
      data: {
        answers: [{ formula: "{w}*{h}", fraction: 1, tolerance: 0.01, toleranceType: "relative", answerDecimals: 2 }],
        variables: [
          { name: "w", min: 2, max: 9, decimals: 1 },
          { name: "h", min: 2, max: 5, decimals: 0 },
        ],
      },
    });
    await question(poolId, { type: "shortanswer", name: "Capital", text: "Capital of Spain?", data: { answers: [{ text: "Madrid", fraction: 1 }] } });
    await question(subId, { type: "gapselect", name: "Gaps", text: "<p>The [[1]] says [[2]].</p>", data: { choices: [{ text: "cow", group: 1 }, { text: "moo", group: 2 }, { text: "cat", group: 1 }, { text: "meow", group: 2 }] } });
    const bad = await admin.req("POST", "/question-bank/questions", { categoryId: poolId, type: "gapselect", name: "x", text: "no gaps", data: { choices: [{ text: "a" }, { text: "b" }] } });
    expect(bad.status).toBe(400);
  });

  it("draws different questions into random slots and grades every type", async () => {
    const qz = await quiz("Mixed");
    expect((await admin.req("POST", `/quizzes/${qz}/slots`, { questionIds: [calcId] })).status).toBe(200);
    const added = await admin.req("POST", `/quizzes/${qz}/random-slots`, { categoryId: poolId, includeSubcategories: true, count: 2 });
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    expect(added.body.map((x: { type: string | null; random: { available: number } | null }) => [x.type, x.random?.available ?? null])).toEqual([
      ["calculated", null],
      [null, 3],
      [null, 3],
    ]);
    expect((await admin.req("PATCH", `/quizzes/${qz}/slots/${added.body[1].id}`, { pinnedVersion: 1 })).status).toBe(400);

    const start = await student.req("POST", `/quizzes/${qz}/attempts`, {});
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    const attemptId = start.body.attemptId;
    const view = await student.req("GET", `/quizzes/${qz}/attempts/${attemptId}`);
    const [calc, ...random] = view.body.questions;
    // The fixed question is never drawn again; the random slots got the other two.
    expect(random.map((q: { type: string }) => q.type).sort()).toEqual(["gapselect", "shortanswer"]);
    const m = /Area of a ([\d.]+) by (\d+) rectangle/.exec(calc.text);
    expect(m, calc.text).toBeTruthy();
    expect(JSON.stringify(view.body)).not.toMatch(/\{w\}|formula|"group"/);
    const gaps = random.find((q: { type: string }) => q.type === "gapselect");
    expect(gaps.view.gaps.map((g: { options: string[] }) => [...g.options].sort())).toEqual([
      ["cat", "cow"],
      ["meow", "moo"],
    ]);
    expect(gaps.text).toBe("<p>The <strong>[1]</strong> says <strong>[2]</strong>.</p>");

    const area = Number(m![1]) * Number(m![2]);
    const save = await student.req("PUT", `/quizzes/${qz}/attempts/${attemptId}/responses`, {
      responses: [
        { slotId: calc.slotId, response: { value: String(area) } },
        { slotId: gaps.slotId, response: { gaps: { "1": "cow", "2": "moo" } } },
        { slotId: random.find((q: { type: string }) => q.type === "shortanswer").slotId, response: { text: "madrid" } },
      ],
    });
    expect(save.status, JSON.stringify(save.body)).toBe(200);
    const fin = await student.req("POST", `/quizzes/${qz}/attempts/${attemptId}/finish`, {});
    expect(fin.body).toMatchObject({ status: "finished", sumMarks: 3, grade: 10 });

    // Reviewers see the right answer computed with this attempt's values.
    const review = await admin.req("GET", `/quizzes/${qz}/attempts/${attemptId}`);
    expect(review.body.questions[0].rightAnswer).toBe(area.toFixed(2));
    const stats = await admin.req("GET", `/quizzes/${qz}/results`);
    expect(stats.body.questions.map((q: { type: string | null }) => q.type)).toEqual(["calculated", null, null]);
  });

  it("refuses to start when a random slot has nothing left to draw", async () => {
    const qz = await quiz("Too few");
    await admin.req("POST", `/quizzes/${qz}/random-slots`, { categoryId: subId, count: 2 });
    const start = await student.req("POST", `/quizzes/${qz}/attempts`, {});
    expect(start.status).toBe(409);
    expect(start.body.error.message).toMatch(/random question/);
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
