// Many learners taking the quiz at once: start/resume, autosave every answer, finish.
//   k6 run loadtest/quiz.js            (VUS / DURATION env vars override the defaults)
import http from "k6/http";
import { check, sleep } from "k6";
import { api, auth, fixture, login } from "./lib.js";

export const options = {
  scenarios: {
    exam: { executor: "ramping-vus", startVUs: 0, stages: [{ duration: "1m", target: Number(__ENV.VUS ?? 100) }, { duration: __ENV.DURATION ?? "3m", target: Number(__ENV.VUS ?? 100) }, { duration: "30s", target: 0 }] },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    "http_req_duration{name:save}": ["p(95)<500"],
    "http_req_duration{name:attempt}": ["p(95)<800"],
    "http_req_duration{name:finish}": ["p(95)<1500"],
  },
};

const tokens = {};

export default function () {
  const student = fixture.students[(__VU - 1) % fixture.students.length];
  tokens[student.id] ??= login(student.email, fixture.password);
  const t = tokens[student.id];

  const start = http.post(api(`/quizzes/${fixture.quizId}/attempts`), "{}", auth(t, "start"));
  if (!check(start, { "start 200": (r) => r.status === 200 })) return;
  const attemptId = start.json("attemptId");
  const attempt = http.get(api(`/quizzes/${fixture.quizId}/attempts/${attemptId}`), auth(t, "attempt"));
  check(attempt, { "attempt 200": (r) => r.status === 200 });
  const questions = attempt.json("questions") ?? [];

  for (const q of questions) {
    sleep(1 + Math.random() * 2); // reading the question
    const res = http.put(api(`/quizzes/${fixture.quizId}/attempts/${attemptId}/responses`), JSON.stringify({ responses: [{ slotId: q.slotId, response: { value: Math.random() < 0.5 } }] }), auth(t, "save"));
    check(res, { "save 200": (r) => r.status === 200 });
  }
  const finish = http.post(api(`/quizzes/${fixture.quizId}/attempts/${attemptId}/finish`), "{}", auth(t, "finish"));
  check(finish, { "finish 200": (r) => r.status === 200 });
  sleep(2);
}
