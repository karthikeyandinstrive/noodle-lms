# Load testing

Scenarios for the paths most likely to hurt on large courses: many learners in a quiz at once,
and teachers opening the gradebook and reports. They use [k6](https://k6.io) (install it
separately, e.g. `brew install k6`) against a running API.

**Never run these against production.** The seed script creates real users and a course.

## 1. Start the API without per-IP rate limits for your machine

Every virtual user comes from one IP, so allow-list it:

```bash
RATE_LIMIT_ALLOWLIST=127.0.0.1,::1 npm run dev:api
```

Use real PostgreSQL (`DATABASE_URL`) for meaningful numbers. The embedded dev database is single-process and much slower.

## 2. Seed a large course

Plan limits apply (the Free plan stops at 50 users), so put the test organization on Pro first:

```sql
UPDATE organizations SET plan = 'pro' WHERE slug = 'default';
```


```bash
BASE_URL=http://localhost:4000 ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD='ChangeMe123!' \
STUDENTS=500 QUESTIONS=20 node loadtest/seed.mjs
```

This writes `loadtest/.data/fixture.json` (git-ignored) with the course, quiz and student logins.

## 3. Run the scenarios

```bash
k6 run -e VUS=200 -e DURATION=5m loadtest/quiz.js
k6 run -e TEACHER_EMAIL=admin@example.com -e TEACHER_PASSWORD='ChangeMe123!' loadtest/gradebook.js
```

Thresholds (p95 latency and under 1% errors) make k6 exit non-zero when they're missed:

| Request | p95 target |
|---|---|
| Quiz autosave | 500 ms |
| Quiz attempt page | 800 ms |
| Quiz finish (grading) | 1.5 s |
| Grader report, course reports | 2 s |
| Gradebook CSV export | 5 s |

Watch `/metrics` (with `METRICS_TOKEN`) and the database while it runs. Pool saturation and slow queries show up there first.
