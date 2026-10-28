# TODO / Pending

Last updated 2026-10-28 (branch `feature/initial-lms`).
Priorities: **P0** blocks production, **P1** do soon, **P2** improvements, **P3** future scope.

## Now — next steps

- [ ] **Open the pull request** `feature/initial-lms` → `main` at https://github.com/karthikeyandinstrive/noodle-lms/pull/new/feature/initial-lms. Opening it starts CI.
- [ ] **Decide repository visibility.** `karthikeyandinstrive/noodle-lms` is currently **public**; switch it to private in Settings → General if needed. No secrets are committed.
- [ ] **Check the first CI run** (typecheck, lint, tests, build, PostgreSQL 16 migrations, Playwright E2E, dependency audit) and fix anything that fails.

## P0 — Before production (needs infrastructure or accounts, not code)

- [ ] **Run on real PostgreSQL 16.** Locally everything ran on embedded PGlite. CI (`.github/workflows/ci.yml` → `postgres` job) runs migrations and the seed against Postgres once the repo has a remote. The `lms_app` role needs `CREATEROLE`, or a DBA must create it.
- [ ] **Run the Docker Compose stack** (Docker isn't installed on the dev machine).
- [ ] **Payments with Stripe/Razorpay test accounts**: checkout, webhooks, refunds.
- [ ] **SSO against real identity providers** (Google / Entra ID / Okta, plus one SAML IdP). Tests only cover an in-process mock OIDC IdP and SAML metadata/redirect.
- [ ] **LTI 1.3 against a real tool** (e.g. the IMS reference tool) and **SCORM** with real packages (SCORM Cloud samples).
- [ ] **H5P player live check.** It loads `h5p-standalone@3.6.0` from jsDelivr with no SRI hash.
- [ ] **Production secrets and TLS**: `ENCRYPTION_KEY`, `URL_SIGNING_SECRET`, `SMTP_URL`, `REDIS_URL` (required with more than one API instance), `METRICS_TOKEN`, storage and Stripe keys.

## P1 — Soon

- [ ] **Manual browser QA of every screen.** Automated E2E covers login, permissions, assignment, grading and notifications. Admin, LTI, SSO, system, search, messages and Spanish were spot-checked; the rest haven't been clicked through.
- [ ] Native-speaker review of the Spanish translations (2,200+ keys).
- [ ] Tracing (OpenTelemetry) and log shipping, once a collector/vendor is chosen. Metrics (`/metrics`) and readiness (`/ready`) are done.
- [ ] **Run the load tests** in `loadtest/` against real PostgreSQL (needs k6) and tune from the results. The scripts and seed are verified against the API; k6 itself hasn't been run.
- [ ] **Decide: plan limits when self-hosted.** `assertWithinLimits` applies the Free plan (50 users, 5 courses) to every organization, even with `SAAS_MODE` off. Self-hosted installs probably want no limits.

## P2 — Improvements

- [ ] LTI: AGS result service, multiple line items per link, course-scoped tools (teachers registering their own tools).
- [ ] SCORM 2004 sequencing rules (pre/post conditions, rollup rules); SCOs can be opened in any order today.
- [ ] Moodle `.mbz` import of question banks, files and grade setup (structure, page/url/label/assign/forum/quiz settings import today).
- [ ] Restore quiz attempts, workshop data and attendance from backups (grades, submissions, groups and forum posts are restored).
- [ ] Search across very large organizations: activity/forum queries filter with `IN (course ids)`; above ~60k courses this needs a join or chunking.

## P3 — Future scope

- [ ] Push notifications / websockets for messages (currently polled)
- [ ] PWA / offline support
- [ ] Native mobile app (the bearer-token API is ready: `POST /auth/token`, MFA via `/auth/mfa/verify?mode=token`)
- [ ] xAPI / LRS integration

## Done

- [x] Monorepo, API core, multi-tenancy with Postgres Row Level Security, context-based RBAC (with capability sync for new releases)
- [x] Every module from the architecture doc (API + UI)
- [x] **SSO** (OIDC with PKCE, SAML 2.0) with account linking, auto-provisioning and enforced mode with an admin break-glass
- [x] **MFA** (TOTP, recovery codes, replay protection, org policy "require MFA for admins")
- [x] **Durable background jobs** (Postgres queue, `SKIP LOCKED`) and a **transactional event outbox** with per-subscriber retries
- [x] **Scheduler**: due-soon reminders, quiz auto-finish, cleanup. **System status** page, `/metrics`, `/ready`
- [x] **LTI 1.3 / Advantage** platform (launch, AGS scores, NRPS, key rotation, JWKS)
- [x] **SCORM 1.2 / 2004** player and runtime
- [x] **Messaging** (direct, group, course; blocking, muting) and **global search**
- [x] **Course backup/restore** (own format) plus best-effort **Moodle .mbz** import
- [x] **i18n** (English + Spanish), **rich-text editor**, WCAG accessibility pass
- [x] GIFT import/export, Unicode certificate PDFs, tenant-aware public URLs, stable blind-marking numbers
- [x] Course- and activity-level permission override UI
- [x] Plan limits enforced, completion re-evaluation when activity rules change
- [x] Dependencies upgraded (zod 4, drizzle 0.45, nodemailer 10, vitest 5): **0 high/critical** vulnerabilities
- [x] Sidebar unread badge for messages; daily notification digest email (per-user opt-in, `notification_digest` task)
- [x] Spanish for API-sourced text (capability descriptions, notification types, plan names), keyed by id in the web app
- [x] Replaced H5P/SCORM packages delete their old extracted files (durable `storage.delete_prefix` job)
- [x] Forum reply/edit editor autofocus; hydration-safe dashboard greeting; removed deprecated `blindOrder` helpers
- [x] Package files are deleted with their SCORM/H5P activity (or course), via an activity-type `remove` hook
- [x] **Restore user data** from backups: group membership, grades (totals recalculated, completion re-evaluated), assignment submissions with files and feedback, forum discussions and posts (users matched by email; others skipped and reported)
- [x] **Multi-SCO SCORM**: per-SCO tracking (`scorm_sco_tracks`), attempt rolled up across SCOs, per-SCO launch settings, lesson navigation in the player
- [x] **LTI Deep Linking 2.0** (teacher picks content in the tool; signed response verified against the tool's JWKS, single use) and **AGS line item create/update** (`lineitem` scope)
- [x] Search: bulk capability resolution (`prefetchCapabilities`) instead of per-course checks, with an equivalence test against `hasCapability`
- [x] **Load-testing kit** (`loadtest/`): seed script for a large course, k6 scenarios for quiz attempts and gradebook/reports with p95 thresholds; `RATE_LIMIT_ALLOWLIST` for test runners
- [x] **411 unit/integration tests**, **8 Playwright E2E tests** (desktop + mobile), GitHub Actions CI, Dependabot
- [x] Pushed to GitHub: `karthikeyandinstrive/noodle-lms` (`main` + `feature/initial-lms`)
