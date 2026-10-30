# CLAUDE.md

Handover notes for anyone (human or Claude Code) working on this repo. Read this first, then
[docs/CONVENTIONS.md](docs/CONVENTIONS.md) (the rules every module follows) and
[docs/TODO.md](docs/TODO.md) (what's done and what's next).

## What this is

A Moodle-style LMS. The original spec is the architecture document the project was built from
(Next.js + Node + PostgreSQL + shadcn/ui, RBAC, API-first, self-host or SaaS). Every module in that
spec is implemented, plus SSO, MFA, LTI 1.3, SCORM, messaging, search, backup/restore and i18n.

The owner wants **complete, production-grade implementations following the spec's best
practices**, not MVP shortcuts. When adding something, finish it (API + UI + tests + i18n).

## Commands

```bash
npm install
npm run db:migrate && npm run db:seed   # embedded dev DB in .data/pglite
npm run dev                             # API :4000 + web :3000 (web proxies /api)
npm run typecheck                       # all workspaces
npm run lint                            # web eslint
npm test                                # API unit + integration (in-memory Postgres) + rbac
npm run test:e2e                        # Playwright; starts its own servers on :3200/:4200
npm run db:generate                     # after editing packages/db/src/schema/*
```

Seeded logins: `admin@`, `teacher@`, `student1@`, `student2@example.com`, password `ChangeMe123!`
(or `SEED_PASSWORD`). API docs at `/api-docs` and `/openapi.json`.

On the original dev Mac, ports 3000/4000 are taken by other projects, so `.claude/launch.json`
runs the app on **3100 (web) / 4100 (API)**. Use whatever is free on your machine.

## Layout

```
apps/api/src/core/        cross-cutting: auth, tenant, rbac, files, storage, events (outbox),
                          jobs (durable queue), worker, notify, mail, metrics, schemas, urls
apps/api/src/modules/<m>/ one folder per feature: index.ts (LmsModule), routes.ts, service.ts,
                          capabilities.ts; registered in modules/index.ts (auth must stay first)
apps/api/test/            integration tests (helpers.ts builds the app on an in-memory DB)
apps/web/src/app/         (auth) sign-in pages, (app) signed-in pages, public verify/badge pages
apps/web/src/features/<m> UI per module; activity types plug into features/activities/registry.ts
apps/web/src/i18n/es.json Spanish strings (English is the inline fallback in t())
packages/db/src/schema/   Drizzle tables; migrations in packages/db/migrations
packages/rbac/            capability catalogue + permission resolution (pure, unit-tested)
e2e/                      Playwright specs + server start script
```

## Gotchas (things that will bite you)

- **The dev DB is single-process.** With no `DATABASE_URL`, the API uses embedded PGlite in
  `.data/pglite`. Only one process can open it, so **stop `npm run dev` before `db:migrate` / `db:seed`**.
  Tests use `PGLITE_DIR=memory://`, which doesn't conflict. Set `DATABASE_URL` to use real Postgres.
- **Never nest transactions.** Inside `req.tenant(async (tx) => …)`, pass `tx` down. Don't call
  `req.tenant`, `withTenant` or `systemDb` again: it deadlocks PGlite and wastes pool connections.
- **Tenancy is enforced by Postgres RLS.** Tenant queries run as role `lms_app` with
  `app.org_id` set. Inserts must set `organizationId`. `jobs`, `event_outbox`,
  `scheduled_task_runs` and `webhook_events` are global (no RLS); filter them by tenant id yourself.
- **Zod 4: use `patchSchema(x)` for PATCH bodies, never `x.partial()`.** In zod 4 `.partial()`
  still applies `.default()` values, so omitted fields get silently reset. There's a regression test.
  `z.record` needs a key schema: `z.record(z.string(), v)`.
- **Events:** prefer `emitInTx(tx, …)` inside a transaction. Use `emit()` only after commit.
  Subscribers (`on(name, fn, { id })`) are retried per handler, so they must be idempotent.
- **Background work:** `defineJob` + `enqueueJob(tx, …)`; emails via `queueMail(tx, …)`. The old
  closure `enqueue()` is deprecated (lost on restart).
- **New capabilities** go in `packages/rbac/src/capabilities.ts`. Migrations run
  `syncDefaultCapabilities`, which grants them to existing organizations' roles. To show one in the
  UI, add it to the capability lists in `courses/routes.ts`, `activities/routes.ts` or
  `auth/service.ts` (site level).
- **Next.js 16** has breaking changes vs older versions; see `apps/web/AGENTS.md` and the docs in
  `node_modules/next/dist/docs/`. Pages are client components using TanStack Query against `/api/v1`.
- **shadcn/ui here is built on Base UI:** polymorphism is the `render` prop, not `asChild`.
  For links styled as buttons use `<Link className={buttonVariants(...)}>`.
- **i18n:** every user-facing string is `t("area.key", "English text")` via `useT()`. Add the Spanish
  entry to `apps/web/src/i18n/es.json` (keep it sorted, valid JSON).
- **Rich text:** use `<RichTextEditor>`. The API sanitizes HTML with `cleanHtml()`, and the web
  renders it with `<HtmlContent>`.
- **Turbopack root:** `apps/web/next.config.ts` sets `turbopack.root` to the repo root (npm hoists
  deps there) and keeps the `@tailwindcss/turbopack` CSS loader. Don't remove either.
- Uploads are restricted to an allow-listed set of MIME types in `core/files.ts`.
- **Data outside the database** (extracted packages in storage) is cleaned up by the activity type's
  `remove` hook, which runs before an activity or its course is deleted. Use `queuePackageCleanup`.
- **Permission checks in loops**: call `prefetchCapabilities(tx, req, caps, contextIds)` first.
  It fills the request's capability cache in a few queries, so the `hasCapability` calls after it are free.
- **Live updates** (`core/live.ts`): call `publishLive(userIds, event)` after the change commits; inside a
  transaction use `afterCommit(tx, () => publishLive(...))` (from `@lms/db`), which never runs on rollback.
  `notify()` already does this for notifications. Events are hints to refetch, never data. The service worker (`apps/web/public/sw.js`) registers in production only and
  never caches `/api`; bump `VERSION` in it when its caching changes.
- **SCORM**: single-SCO packages keep the CMI on `scorm_attempts`; multi-SCO packages use
  `scorm_sco_tracks` (one row per SCO), and the attempt row then holds the rolled-up result. Packages with
  IMS Simple Sequencing keep their activity tree in `manifest.sequencing.tree`; `scorm/sequencing.ts` (pure,
  unit-tested) decides availability, Next/Previous and the rolled-up status.
- **Quiz questions**: question types live in `quiz/question-types.ts` (data schema, grading, learner view).
  Grading and display take the attempt's `variant` (shuffles, calculated values) and the question text
  (gap-select gaps are `[[n]]` in the text). A quiz slot is either a question or a random category draw
  (`quiz_slots.random_category_id`); random picks are frozen on `attempt_answers` when the attempt starts.
- Missing **or forbidden** resources return 404, so their existence isn't leaked. Keep that pattern.

## Current state (2026-10-30)

- Branch `feature/initial-lms` is pushed to https://github.com/karthikeyandinstrive/noodle-lms
  (`main` holds only the Create Next App scaffold). **The PR is not opened yet**; opening it runs CI.
- 450 unit/integration tests and 8 E2E tests pass, on embedded PGlite and on real PostgreSQL 18 as a
  non-superuser (`npm run test:postgres`). Typecheck, lint and the production build are clean.
  `npm audit` reports no high or critical findings.
- **Never tested against real services:** the Docker Compose stack, Stripe/Razorpay, real SSO IdPs,
  real LTI tools/SCORM packages, the H5P player. The runbook for each is docs/PRODUCTION.md.
- The repo is currently **public**; the owner still has to decide on visibility.

Next steps are at the top of [docs/TODO.md](docs/TODO.md).
