# TODO / Pending

Last updated 2026-10-30 (branch `feature/initial-lms`).
Priorities: **P0** blocks production, **P1** do soon, **P2** improvements, **P3** future scope.

## Now — next steps

- [ ] **Open the pull request** `feature/initial-lms` → `main` at https://github.com/karthikeyandinstrive/noodle-lms/pull/new/feature/initial-lms. Opening it starts CI.
- [ ] **Decide repository visibility.** `karthikeyandinstrive/noodle-lms` is currently **public**; switch it to private in Settings → General if needed. No secrets are committed.
- [ ] **Check the first CI run** (typecheck, lint, tests, build, PostgreSQL 16 migrations, Playwright E2E, dependency audit) and fix anything that fails.

## P0 — Before production (needs your accounts or infrastructure)

Step-by-step checks for each item are in [PRODUCTION.md](PRODUCTION.md).

- [x] **Real PostgreSQL**: migrations (idempotent), seed, all integration tests and E2E pass on PostgreSQL 18 as a non-superuser owner; CI runs the same on PostgreSQL 16. Found and fixed two bugs only real Postgres shows (see Done).
- [x] **Production secrets and config checks**: `npm run secrets`; the API refuses to start with unsafe config and warns about degraded settings.
- [ ] **Docker Compose stack**: needs Docker on a machine (not installed here).
- [ ] **TLS and real secrets** on the production host (proxy in front, `APP_URL=https://…`, SMTP, Redis, S3).
- [ ] **Payments** with Stripe/Razorpay test accounts: checkout, webhooks, refunds, SaaS subscriptions.
- [ ] **SSO** against real identity providers (Google / Entra ID / Okta, plus one SAML IdP).
- [ ] **LTI 1.3** against a real tool (IMS reference tool or saLTIre); needs a publicly reachable staging URL.
- [ ] **SCORM** with real packages (Rustici Golf examples, including multi-SCO).
- [ ] **H5P** live check and SRI hashes (or self-hosting) for `h5p-standalone@3.6.0`.

## P1 — Soon

- [ ] **Manual browser QA of every screen.** Automated E2E covers login, permissions, assignment, grading and notifications. On 2026-10-30 all 41 main admin, course, activity and learner screens loaded without errors (as admin), and the new features were clicked through: question editor (calculated, gap select), random quiz slots, quiz attempt and review, sequenced SCORM player, live notification badge. Still to click through by hand: every form's edge cases, the learner and teacher views of each activity type, and Spanish.
- [ ] Native-speaker review of the Spanish translations (2,200+ keys).
- [ ] Tracing (OpenTelemetry) and log shipping, once a collector/vendor is chosen. Metrics (`/metrics`) and readiness (`/ready`) are done.
- [ ] **Run the load tests** in `loadtest/` against real PostgreSQL (needs k6) and tune from the results. The scripts and seed are verified against the API; k6 itself hasn't been run.

## P2 — Improvements

- [ ] SCORM 2004 sequencing, the parts not done yet: shared global objectives / objective maps (cross-SCO prerequisites via `referencedObjective`), time limits, constrained choice and `preventActivation`, rollup considerations. See the header of `scorm/sequencing.ts`.
- [ ] Moodle `.mbz` import, the parts not done yet: `calculatedmulti`, image drag-and-drop (`ddimageortext`, `ddmarker`), embedded answers (cloze / `multianswer`), scales and outcomes, calculated grade-item formulas, files of HTML-package resources beyond the main file.
- [ ] A drag-and-drop presentation for gap-select questions (today each gap is an accessible drop-down, which also covers Moodle "drag and drop into text").

## P3 — Future scope

- [ ] Web push notifications (the service worker is in place; needs VAPID keys and a subscription store)
- [ ] Offline reading of course content (today offline shows a friendly page; nothing is cached for reading)
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
- [x] Plan limits apply only in SaaS mode (or with `ENFORCE_PLAN_LIMITS=true`); self-hosted installs are unlimited
- [x] Search no longer sends huge `IN (course ids)` lists for organization-wide staff
- [x] LTI AGS **result service** (`result.readonly`) and **course-level tools** registered by teachers (`lti:manage_course_tools`, course "External tools" tab)
- [x] Moodle `.mbz` import of the **question bank** (3.x and 4.x layouts; multichoice, true/false, short answer, numerical, essay, matching) and quiz question slots
- [x] Backups now include and restore **finished quiz attempts** (with answers) and **attendance records**
- [x] Backups restore **workshop submissions and peer assessments** (with files)
- [x] Moodle `.mbz` import of **embedded images/files** in course, section, page, assignment and intro HTML (`@@PLUGINFILE@@` links rewritten)
- [x] LTI **multiple line items** per resource link (extra gradebook columns; create/read/update/delete, scores and results per line item)
- [x] **Live message updates** over server-sent events (`/messages/stream`, Redis pub/sub across replicas; polling stays as the fallback)
- [x] **Installable PWA**: manifest, icons, service worker with an offline page (production builds only)
- [x] Fixed: events emitted right after storing them could skip immediate dispatch (JS vs database clock precision); they now compare with the database clock
- [x] Fixed: on PostgreSQL 16+, a non-superuser app owner couldn't switch to `lms_app` (every request failed); migrations now grant it explicitly and fail with instructions if they can't
- [x] **450 unit/integration tests**, **8 Playwright E2E tests** (desktop + mobile), GitHub Actions CI, Dependabot
- [x] Pushed to GitHub: `karthikeyandinstrive/noodle-lms` (`main` + `feature/initial-lms`)
- [x] **SCORM 2004 Simple Sequencing** (`scorm/sequencing.ts`): control modes (choice, choiceExit, flow, forwardOnly), pre/exit/post-condition rules, attempt limits, rollup rules with defaults, measure rollup, `tracked`, sequencing collections; the player follows the rules (locked lessons, Next/Previous by flow, `adl.nav.request` and `adl.nav.request_valid.*`), and the attempt's status is the organization's rolled-up status
- [x] **Live notification updates** over the same server-sent event stream as messages (bell and lists refresh when a notification arrives or is read in another tab); `afterCommit(tx, fn)` in `@lms/db` runs side effects only after the transaction commits
- [x] **Random quiz questions** (random slots draw a question from a category, optionally with subcategories, per attempt, never repeating one already in the attempt), included in backup/restore
- [x] **Calculated questions** (wildcards drawn per attempt or from fixed datasets, safe formula evaluator, relative/nominal/geometric tolerance) and **gap-select questions** (select missing words / drag-and-drop into text), with editors and attempt UI
- [x] Moodle `.mbz` import of the **gradebook setup** (categories, aggregation, drop lowest, weights, pass grades, hidden/locked, manual items), **file resources** and **folders**, **calculated / calculatedsimple**, **ddwtos / gapselect** and **random questions** (3.x and 4.x)
