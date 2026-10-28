// Teachers opening the grader report, course reports and exports on a large course.
//   k6 run loadtest/gradebook.js       (needs TEACHER_EMAIL / TEACHER_PASSWORD, e.g. the admin)
import http from "k6/http";
import { check, sleep } from "k6";
import { api, auth, fixture, login } from "./lib.js";

export const options = {
  vus: Number(__ENV.VUS ?? 10),
  duration: __ENV.DURATION ?? "2m",
  thresholds: {
    http_req_failed: ["rate<0.01"],
    "http_req_duration{name:grader}": ["p(95)<2000"],
    "http_req_duration{name:overview}": ["p(95)<2000"],
    "http_req_duration{name:participation}": ["p(95)<2000"],
    "http_req_duration{name:export}": ["p(95)<5000"],
  },
};

export function setup() {
  return { token: login(__ENV.TEACHER_EMAIL, __ENV.TEACHER_PASSWORD) };
}

export default function (data) {
  const c = fixture.courseId;
  check(http.get(api(`/grades/courses/${c}`), auth(data.token, "grader")), { "grader 200": (r) => r.status === 200 });
  sleep(1);
  check(http.get(api(`/reports/courses/${c}/overview`), auth(data.token, "overview")), { "overview 200": (r) => r.status === 200 });
  check(http.get(api(`/reports/courses/${c}/participation`), auth(data.token, "participation")), { "participation 200": (r) => r.status === 200 });
  check(http.get(api(`/quizzes/${fixture.quizId}/results`), auth(data.token, "quizResults")), { "results 200": (r) => r.status === 200 });
  if (Math.random() < 0.2) check(http.get(api(`/grades/courses/${c}/export.csv`), auth(data.token, "export")), { "export 200": (r) => r.status === 200 });
  sleep(2);
}
