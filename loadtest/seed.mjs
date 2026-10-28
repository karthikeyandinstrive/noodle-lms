#!/usr/bin/env node
/**
 * Builds a large course to load-test against, through the public API:
 * one course, N enrolled students (same password), a quiz with Q true/false questions
 * and an assignment. Writes the ids to loadtest/.data/fixture.json for the k6 scripts.
 *
 *   BASE_URL=http://localhost:4000 ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=… \
 *   STUDENTS=500 QUESTIONS=20 node loadtest/seed.mjs
 *
 * Run the API with RATE_LIMIT_ALLOWLIST set to this machine's IP, or seeding is rate limited.
 * Never point this at production: it creates real users.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const BASE = (process.env.BASE_URL ?? "http://localhost:4000").replace(/\/+$/, "");
const STUDENTS = Number(process.env.STUDENTS ?? 200);
const QUESTIONS = Number(process.env.QUESTIONS ?? 20);
const PASSWORD = process.env.STUDENT_PASSWORD ?? "LoadTest123!";
const RUN = Date.now().toString(36);

async function call(token, method, url, body) {
  const res = await fetch(`${BASE}/api/v1${url}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (res.status === 402) {
    throw new Error(`${data?.error?.message ?? "Plan limit reached"} Put the organization on a plan without user/course limits for load testing, e.g. UPDATE organizations SET plan = 'pro' WHERE slug = '<org>';`);
  }
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${JSON.stringify(data)?.slice(0, 300)}`);
  return data;
}

const email = process.env.ADMIN_EMAIL;
const password = process.env.ADMIN_PASSWORD;
if (!email || !password) {
  console.error("Set ADMIN_EMAIL and ADMIN_PASSWORD (an account with site administration rights).");
  process.exit(1);
}
const login = await call(null, "POST", "/auth/token", { email, password });
if (!login.token) throw new Error("The admin account needs MFA; use one without it for load testing");
const admin = login.token;

const course = await call(admin, "POST", "/courses", { fullname: `Load test ${RUN}`, shortname: `LOAD-${RUN}` });
const sectionId = (await call(admin, "GET", `/courses/${course.id}`)).sections[0].id;
console.log(`course ${course.id}`);

const students = [];
for (let i = 0; i < STUDENTS; i++) {
  const u = await call(admin, "POST", "/users", {
    email: `load-${RUN}-${i}@example.test`,
    firstName: "Load",
    lastName: `Student ${i}`,
    password: PASSWORD,
    sendInvite: false,
  });
  students.push({ id: u.id, email: u.email });
  if ((i + 1) % 50 === 0) console.log(`${i + 1}/${STUDENTS} students`);
}
for (let i = 0; i < students.length; i += 500) {
  await call(admin, "POST", `/courses/${course.id}/enrolments`, { userIds: students.slice(i, i + 500).map((s) => s.id) });
}

const quiz = await call(admin, "POST", `/courses/${course.id}/activities`, {
  type: "quiz",
  sectionId,
  name: "Load test quiz",
  settings: { attemptsAllowed: 0, gradeMax: QUESTIONS },
});
const category = await call(admin, "POST", "/question-bank/categories", { courseId: course.id, name: "Load test" });
const questionIds = [];
for (let i = 0; i < QUESTIONS; i++) {
  const q = await call(admin, "POST", "/question-bank/questions", { categoryId: category.id, type: "truefalse", name: `Q${i + 1}`, text: `Statement ${i + 1}`, data: { correct: i % 2 === 0 } });
  questionIds.push(q.id);
}
await call(admin, "POST", `/quizzes/${quiz.id}/slots`, { questionIds });
const assignment = await call(admin, "POST", `/courses/${course.id}/activities`, {
  type: "assignment",
  sectionId,
  name: "Load test assignment",
  settings: { allowText: true, allowFiles: false, gradeMax: 100 },
});

const out = path.join(import.meta.dirname, ".data", "fixture.json");
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ baseUrl: BASE, courseId: course.id, quizId: quiz.id, assignmentId: assignment.id, password: PASSWORD, students }, null, 2));
console.log(`wrote ${out}`);
