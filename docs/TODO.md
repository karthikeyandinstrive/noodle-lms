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
- [ ] Native-speaker review of the Spanish translations (2,100+ keys).
- [ ] Tracing (OpenTelemetry) and log shipping. Metrics (`/metrics`) and readiness (`/ready`) are done.

## P2 — Improvements

- [ ] LTI Deep Linking, AGS line-item create/update and result service, course-scoped tools.
- [ ] Multi-SCO SCORM packages and sequencing/navigation (only the first SCO plays today).
- [ ] Moodle `.mbz` import of question banks, files and grade setup (structure, page/url/label/assign/forum/quiz settings import today).
- [ ] Restore user data such as grades, submissions and forum posts from backups (it is exported but not restored).
- [ ] Delete extracted H5P/SCORM package files when the activity itself is deleted (replacing a package already cleans up).
- [ ] Search performance for staff in very large organizations (per-course capability checks).
- [ ] Load testing (quiz attempts, gradebook, reports on large courses).

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
- [x] **400 unit/integration tests**, **8 Playwright E2E tests** (desktop + mobile), GitHub Actions CI, Dependabot
- [x] Pushed to GitHub: `karthikeyandinstrive/noodle-lms` (`main` + `feature/initial-lms`)
