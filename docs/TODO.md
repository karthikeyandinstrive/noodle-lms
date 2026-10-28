# TODO / Pending

Status as of 2026-10-28 (commit `e4150fc`, branch `feature/initial-lms`).
Sorted by priority: **P0** blocks production, **P1** must do soon, **P2** improvements, **P3** future scope.

## P0 — Before production

- [ ] **Browser QA of every screen.** Only one flow was checked in the running app: assignment create → submit → grade → gradebook → completion. Click through all 56 routes as admin, teacher and student, on desktop and mobile.
- [ ] **Test on real PostgreSQL.** Everything so far ran on the embedded PGlite. Run migrations, Row Level Security and the test suite against Postgres 16. The `lms_app` role needs `CREATEROLE`, or must be created by a DBA.
- [ ] **Test the Docker Compose stack.** It hasn't been run because Docker isn't installed on this machine. Check the web + api + db + redis + minio images, the `migrate` job and the standalone Next build.
- [ ] **Payments end to end.** Use Stripe and Razorpay test accounts: checkout, webhooks, refunds, and the redirect back ("Confirming your payment…").
- [ ] **SSO login (SAML / OIDC).** Listed in the architecture doc and not implemented.
- [ ] **Durable background jobs.** `core/jobs.ts` runs jobs in-process, so emails, certificate issuing and badge awards are lost on restart. Move to BullMQ on Redis.
- [ ] **Reliable events.** Events are emitted after commit with no outbox, so a crash between commit and emit loses side effects (completion, certificates, notifications). Add a transactional outbox table and a worker.
- [ ] **Production secrets and config.** Set `ENCRYPTION_KEY`, `URL_SIGNING_SECRET`, `SMTP_URL`, `REDIS_URL`, storage credentials and Stripe keys. Put TLS in front of the web app.
- [ ] **Dependency vulnerabilities.** `npm install` reported 11 (2 critical). Run `npm audit` and fix them.

## P1 — Soon

- [ ] **H5P player.** Untested live. It loads `h5p-standalone@3.6.0` from jsDelivr without an SRI hash; add the hash or self-host it. Check that `X-Frame-Options: SAMEORIGIN` doesn't block inner iframes.
- [ ] **Multi-factor authentication** (TOTP). The doc lists it as optional.
- [ ] **Plan limits.** `billing/service.ts → assertWithinLimits()` exists but isn't called when users or courses are created.
- [ ] **CI pipeline.** GitHub Actions running typecheck, lint, tests and build; Dependabot; `npm audit` on PRs.
- [ ] **Web end-to-end tests** (Playwright) for login, enrolment, assignment, quiz attempt, forum post and checkout. The web app has no automated tests today.
- [ ] **Scheduled jobs (cron).** "Assignment due soon" reminders, auto-finishing expired quiz attempts in the background, session cleanup and digest emails.
- [ ] **Course completion re-evaluation.** It isn't recalculated when an activity's completion rule or visibility changes; it only updates on the learner's next event.
- [ ] **Course-level permission overrides UI.** The API exists (`/contexts/:id/overrides`); the roles page only edits role defaults.
- [ ] **Public URLs per tenant.** Certificate verify links, QR codes and Open Badges IDs use `APP_URL`, not the organization's subdomain or custom domain.
- [ ] **Remote and PR.** The repo has no remote yet. Push the branch and open a PR.
- [ ] **README.** Mention the known gaps (SSO, in-process jobs) in the security section.

## P2 — Improvements

- [ ] **Rich-text editor** (e.g. Tiptap) for pages, forum posts, feedback and descriptions. Today these are plain textareas converted to HTML and sanitized on the server.
- [ ] **Unicode fonts in certificate PDFs.** Standard Helvetica can't render non-Latin names.
- [ ] **GIFT import/export** for the question bank. Only JSON is supported.
- [ ] **Accessibility audit (WCAG 2.1 AA).** Links styled as buttons currently get `role="button"`; use `buttonVariants` on `<Link>` instead.
- [ ] **Stable blind-marking numbers.** "Participant N" can shift when enrolments change.
- [ ] **A notification type for grade overrides.** They currently reuse `assignment_graded` / `quiz_graded`.
- [ ] **Observability.** Metrics (Prometheus), tracing (OpenTelemetry), log shipping and a readiness probe that checks the DB and Redis.
- [ ] **Load testing** of quiz attempts, the gradebook and reports on large courses.
- [ ] **Internationalisation (i18n)** of the UI. The `locale` field exists on users but strings are English only.

## P3 — Future scope (beyond the architecture doc)

- [ ] LTI 1.3 (tool consumer and provider)
- [ ] SCORM / xAPI packages
- [ ] Course backup / restore / import (including Moodle `.mbz`)
- [ ] Direct messaging between users
- [ ] Global search
- [ ] PWA / offline support
- [ ] Native mobile app (bearer-token API already supported via `POST /auth/token`)

## Done

- [x] Monorepo, API core, multi-tenancy with Row Level Security, context-based RBAC
- [x] All modules from the architecture doc (API + UI) — see README
- [x] OpenAPI docs, Docker Compose, `.env.example`, README, `docs/CONVENTIONS.md`
- [x] 197 unit + integration tests passing; typecheck, lint and production builds clean
- [x] Initial commit on `feature/initial-lms`
