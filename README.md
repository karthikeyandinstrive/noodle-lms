# LMS

A Moodle-style learning management system built on **Next.js 16 + TypeScript**, **Fastify**, **PostgreSQL (Drizzle)** and **shadcn/ui**.
It is API-first and multi-tenant, uses context-based RBAC, and can be self-hosted or run as SaaS.

## Quick start (development)

Requires Node.js 20+. PostgreSQL and Redis are **not** needed for development: the API falls back to an embedded Postgres (PGlite, stored in `.data/`) and in-memory caches.

```bash
npm install
npm run db:migrate
npm run db:seed
npm run dev
```

- Web app: http://localhost:3000
- API docs (OpenAPI / Scalar): http://localhost:3000/api-docs. The raw spec is at `/openapi.json`; `npm run openapi:export` writes `openapi.json`.
- Seeded accounts: `admin@example.com`, `teacher@example.com`, `student1@example.com`, `student2@example.com`. The password is the `SEED_PASSWORD` env var, or `ChangeMe123!` in development.

> The embedded dev database allows **one process at a time**. Stop `npm run dev` before running `db:migrate`, `db:seed` or `db:reset`.
> To use a real Postgres, set `DATABASE_URL` in `.env` (see `.env.example`).

## Architecture

```
apps/web    Next.js (App Router) UI. Proxies /api/* to the API, so cookies stay first-party.
apps/api    Fastify REST API, /api/v1/*. Zod schemas drive validation and the OpenAPI docs.
packages/db       Drizzle schema, migrations, Row Level Security, seed
packages/rbac     Capability catalogue + Moodle-style permission resolution
```

Engineering rules for contributors: **[docs/CONVENTIONS.md](docs/CONVENTIONS.md)**. What's left: **[docs/TODO.md](docs/TODO.md)**.
Operations: `GET /ready` (readiness), `GET /metrics` (Prometheus, needs `METRICS_TOKEN`), and the in-app **System status** page.

### Modules (plugin equivalents)

Every feature lives in `apps/api/src/modules/<name>` (`routes.ts`, `service.ts`, `capabilities.ts`) and is registered in `modules/index.ts`.
Its UI lives in `apps/web/src/features/<name>`.

| Area | Modules |
|---|---|
| Core | auth, **MFA (TOTP)**, **SSO (OIDC, SAML)**, users & cohorts, roles & permissions (incl. course/activity overrides), organization (settings, storage, audit log), files, courses (categories, sections, enrolment, groups), activities |
| Engines | gradebook, completion, notifications, calendar, reports, scheduler & system status, global search, messaging, course backup/restore (+ Moodle .mbz import) |
| Activities | page / url / file, assignment, quiz + question bank (JSON & GIFT), forum, workshop (peer assessment), attendance, interactive (H5P/embeds), video meetings, certificate, **external tool (LTI 1.3)**, **SCORM 1.2/2004** |
| Engagement | badges (Open Badges 2.0 assertions), certificates (Unicode PDF + public verification) |
| Commerce | course payments (Stripe, Razorpay), SaaS billing (Stripe subscriptions, plan limits) |

Background work runs on a **durable Postgres job queue** and domain events go through a **transactional outbox** (at-least-once, per-subscriber retries). The worker runs inside the API by default (`RUN_WORKER=false` + `node dist/worker.js` to scale it separately).
The UI is translated (English, Spanish), accessible (WCAG 2.1 AA pass) and uses a Tiptap rich-text editor for user content.

### RBAC

Moodle's model: **roles are assigned in a context** (system → category → course → activity). Permissions inherit down the tree, and per-context **overrides** (`allow` / `prevent` / `prohibit`) can change them.
`prohibit` always wins, the most specific override wins per role, and a user is allowed if any of their roles allows.
See `packages/rbac/src/resolve.ts` (unit-tested) and `apps/api/src/core/rbac.ts`.

### Multi-tenancy

Every tenant table has `organization_id`. Requests resolve the organization from the host (custom domain → `<slug>.BASE_DOMAIN` → `DEFAULT_ORG_SLUG`). All tenant queries run in a transaction that sets `app.org_id` and switches to the `lms_app` role, so **Postgres Row Level Security** isolates tenants even if application code forgets a filter.

### Security

- Opaque server-side sessions: an httpOnly, Secure, SameSite=Lax cookie (`__Host-` prefix in production), with only the token's SHA-256 stored. Sessions have idle and absolute timeouts and a fresh token on login. Password change or reset revokes other sessions. Bearer tokens are available for mobile clients (`POST /auth/token`).
- Passwords use argon2id (OWASP parameters). Accounts lock after repeated failures, login timing is constant (no user enumeration), and reset tokens are single-use and stored hashed.
- CSRF: Origin check on cookie-authenticated mutations, plus SameSite cookies.
- Optional TOTP two-factor auth (org policy can require it for admins), SSO with PKCE/state/nonce (OIDC) and signed assertions with replay protection (SAML).
- Redis-backed rate limiting (global, plus strict limits on auth, payment and upload endpoints). Helmet and security headers are set on both apps.
- Zod validation on every input. Response schemas whitelist output fields, which prevents mass assignment and over-exposure. Missing or forbidden resources both return 404 (IDOR-safe).
- Uploads go straight to storage through presigned URLs, with type and size validation, a blocked-extension list, per-component access rules and short-lived signed downloads.
- Storage and payment secrets are encrypted with AES-256-GCM. User-supplied storage endpoints are checked against private and metadata IP ranges (SSRF).
- User HTML is sanitized on write. Admin and teacher actions are audit-logged. GDPR data export and erasure (anonymization) are supported.

## Production

```bash
cp .env.example .env     # set ENCRYPTION_KEY, URL_SIGNING_SECRET, POSTGRES_PASSWORD, MINIO_ROOT_PASSWORD, SEED_PASSWORD
docker compose up -d --build
docker compose run --rm migrate
```

The compose stack runs web, api, PostgreSQL 16, Redis 7 and MinIO. Put a TLS-terminating reverse proxy (Caddy, Nginx or Cloudflare) in front of `web:3000`.
For SaaS, set `SAAS_MODE=true` and `BASE_DOMAIN`, point wildcard DNS at the proxy, and organizations sign up at `/signup`.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | migrate, then run API (:4000) and web (:3000) |
| `npm run db:generate` | generate a migration after editing `packages/db/src/schema` |
| `npm run db:migrate` / `db:seed` / `db:reset` | apply migrations + RLS / seed demo data / wipe (dev only) |
| `npm run typecheck` / `npm test` | type-check / run unit + integration tests in all workspaces |
| `npm run test:e2e` | Playwright end-to-end tests (starts its own servers on :3200/:4200 with a throwaway DB) |
| `npm run openapi:export` | write `openapi.json` |
