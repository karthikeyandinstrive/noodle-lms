# Production readiness runbook

What has been verified, and the exact steps for the checks that need your accounts or
infrastructure. Work top to bottom; each section ends with what "done" looks like.

## Verified already

| Area | How |
|---|---|
| PostgreSQL | Migrations (twice, idempotent), seed, all 12 integration test files (160 tests) and the Playwright E2E suite on **PostgreSQL 18**, with the app connecting as a **non-superuser** database owner. CI repeats this on **PostgreSQL 16** (`postgres` job). |
| Tenant isolation | Row Level Security policies on every tenant table; the app switches to the non-superuser `lms_app` role per request. Migrations stop with instructions if that switch isn't allowed. |
| Production config | The API refuses to start with missing/placeholder secrets, a non-https `APP_URL`, incomplete S3 or Stripe settings, and logs warnings for SMTP, Redis, metrics and local storage (`apps/api/src/production-check.ts`). |
| PWA, live updates | Service worker + offline page in Chromium; server-sent events through the Next.js proxy on a production build. |

Run the Postgres suite yourself against any server where you have a superuser:

```bash
ADMIN_URL=postgresql://postgres:PASSWORD@localhost:5432/postgres npm run test:postgres
```

## 1. Secrets and TLS

1. `npm run secrets` prints `ENCRYPTION_KEY`, `URL_SIGNING_SECRET` and `METRICS_TOKEN`. Store them in your secret manager. **Never rotate `ENCRYPTION_KEY` casually**: it decrypts stored storage and payment-gateway credentials.
2. Set `APP_URL=https://…` (the API refuses plain http except on localhost) and `TRUST_PROXY=true` behind your load balancer.
3. Terminate TLS at the proxy (Caddy, nginx, a cloud load balancer). Forward `/` to the web container (port 3000). The web app proxies `/api` to the API itself.
4. Set `SMTP_URL` and a real `MAIL_FROM`, `REDIS_URL` (required with more than one API instance), and S3/MinIO/R2 storage.

**Done when:** the API starts with no `config:` warnings you didn't choose, `https://<host>/ready` returns `{"status":"ready"}`, and a password-reset email arrives.

## 2. Database role

The app's database user must **own the database** and either have `CREATEROLE` (it creates `lms_app` itself) or have a DBA run, once:

```sql
CREATE ROLE lms_app NOLOGIN;
GRANT lms_app TO lms_owner WITH INHERIT FALSE, SET TRUE;   -- PostgreSQL 16+
-- PostgreSQL 15 and older: GRANT lms_app TO lms_owner;
```

Never run the app as a superuser in production: superusers bypass Row Level Security.

**Done when:** `npm run db:migrate` succeeds as that user (it checks the role switch) and `npm run test:postgres` passes against a staging server.

## 3. Docker Compose stack

Needs Docker (Docker Desktop, OrbStack, or `brew install colima docker docker-compose && colima start`).

```bash
cp .env.example .env            # then fill in the secrets from step 1, POSTGRES_PASSWORD, MINIO_ROOT_PASSWORD, SEED_PASSWORD
docker compose up -d --build
docker compose run --rm migrate
```

**Done when:** `docker compose ps` shows web, api, db, redis and minio healthy; you can sign in at http://localhost:3000, upload a file (stored in MinIO), and `docker compose restart api` keeps your session and files.

## 4. Payments (test mode)

### Stripe (course checkout, per organization)
1. In a Stripe **test-mode** account, copy the publishable and secret keys.
2. In the LMS: Site administration → Payments → add Stripe with those keys.
3. Forward webhooks locally: `stripe listen --forward-to localhost:4000/api/v1/payments/webhooks/stripe/<organizationId>` and paste the printed `whsec_…` as the webhook secret. In production, add an endpoint in the Stripe dashboard for the same path with events `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`.
4. Put a price on a course, check out as a student with card `4242 4242 4242 4242`, then refund from the Stripe dashboard.

**Done when:** the student is enrolled after paying, the order shows "paid", a receipt notification arrives, and after the refund the order shows "refunded".

### Stripe (SaaS subscriptions, platform account)
Set `SAAS_MODE=true`, `STRIPE_SECRET_KEY`, `STRIPE_PRICE_PRO` and `STRIPE_WEBHOOK_SECRET`. The webhook endpoint is `/api/v1/billing/webhooks/stripe`, with events `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.paused`, `customer.subscription.resumed`.

**Done when:** upgrading in Site administration → Subscription moves the organization to Pro, and cancelling in the Stripe portal moves it back at period end.

### Razorpay
1. Razorpay **test mode** keys (`rzp_test_…`) → Site administration → Payments.
2. Webhook URL `/api/v1/payments/webhooks/razorpay/<organizationId>` with events `order.paid`, `payment.captured`, `refund.processed` and your webhook secret.

**Done when:** a test payment enrols the student and a refund updates the order.

## 5. Single sign-on

For each provider, create a developer app, then in Site administration → Single sign-on add the provider and copy the shown **Redirect (callback) URI** (`/api/v1/sso/<slug>/callback`) into the provider.

| Provider | Where |
|---|---|
| Google | Google Cloud console → APIs & Services → Credentials → OAuth client (Web). Issuer `https://accounts.google.com`. |
| Microsoft Entra ID | Entra admin center → App registrations. Issuer `https://login.microsoftonline.com/<tenant-id>/v2.0`. |
| Okta | Okta developer account → Applications → OIDC Web app. Issuer `https://<your-domain>.okta.com`. |
| SAML (e.g. Okta SAML, Entra Enterprise app, Keycloak) | Use the LMS SAML metadata URL; ACS is `/api/v1/sso/<slug>/acs`. |

**Done when, per provider:** a new user signs in and is created (if auto-provisioning is on), an existing user is linked by verified email, "enforced" mode hides the password form, and the admin break-glass login still works.

## 6. LTI 1.3 with a real tool

The tool must reach your LMS over the internet (it fetches your JWKS and calls the token and AGS endpoints), so use a staging URL or a tunnel.

1. Register a tool in Site administration → External tools, copy the platform details (issuer, client id, deployment id, auth/token/JWKS URLs) into the tool.
2. Good test tools: the **IMS LTI reference implementation** (free account at lti-ri.imsglobal.org) or **saLTIre** (saltire.lti.app).
3. Add the tool to a course, launch as a teacher and a student, use **Choose content in the tool** (Deep Linking), and send a score.

**Done when:** launches succeed for both roles, Deep Linking updates the activity, the tool's score appears in the gradebook, the tool can read the roster (NRPS), and an extra line item appears as its own gradebook column.

## 7. SCORM with real packages

Download Rustici's free sample packages (scorm.com → SCORM resources → "Golf Examples" for SCORM 1.2 and 2004, including a multi-SCO one) and add each as a SCORM activity.

**Done when:** each package plays, resumes where the learner left off, records completion and score in the gradebook, and the multi-SCO package shows every lesson in the player's lesson picker.

## 8. H5P player

The player loads `h5p-standalone@3.6.0` from jsDelivr (`apps/api/src/modules/interactive/player.ts`).

1. Download a sample `.h5p` from h5p.org (content type "Interactive Video" or "Multiple Choice") and add it as interactive content.
2. Pin integrity hashes: download `main.bundle.js` and `frame.bundle.js` for that version, compute `openssl dgst -sha384 -binary FILE | openssl base64 -A`, and add `integrity="sha384-…" crossorigin="anonymous"` to the script tags in the player. Or self-host the two files so no CDN is needed.

**Done when:** the content plays inside the LMS, completion and score reach the gradebook, and the page loads with the integrity attributes in place.
