/**
 * Production readiness of the configuration (pure, unit-tested). `errors` stop the API from
 * starting; `warnings` are logged at startup. Generate secrets with `npm run secrets`.
 */
export type ProductionEnv = {
  APP_URL: string;
  ENCRYPTION_KEY?: string;
  URL_SIGNING_SECRET?: string;
  DATABASE_URL?: string;
  REDIS_URL?: string;
  SMTP_URL?: string;
  MAIL_FROM: string;
  METRICS_TOKEN?: string;
  STORAGE_DRIVER: string;
  S3_BUCKET?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
  SAAS_MODE: boolean;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_PRO?: string;
  TRUST_PROXY: boolean;
  RATE_LIMIT_ALLOWLIST: string;
};

const isLocalHost = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");

export function productionProblems(env: ProductionEnv): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  const key = env.ENCRYPTION_KEY ? Buffer.from(env.ENCRYPTION_KEY, "base64") : null;
  if (!key) errors.push("ENCRYPTION_KEY is required");
  else if (key.length !== 32) errors.push("ENCRYPTION_KEY must be 32 random bytes, base64-encoded");
  else if (key.every((b) => b === key[0])) errors.push("ENCRYPTION_KEY looks like a placeholder; generate a random one");

  if (!env.URL_SIGNING_SECRET) errors.push("URL_SIGNING_SECRET is required");
  else if (env.URL_SIGNING_SECRET.length < 32) errors.push("URL_SIGNING_SECRET must be at least 32 characters");
  else if (/^dev-url-signing-secret|change-?me|replace-?me|your[-_]?secret/i.test(env.URL_SIGNING_SECRET)) errors.push("URL_SIGNING_SECRET looks like a placeholder; generate a random one");

  if (!env.DATABASE_URL) errors.push("DATABASE_URL is required (PostgreSQL 15+)");

  let appUrl: URL | null = null;
  try {
    appUrl = new URL(env.APP_URL);
  } catch {
    errors.push("APP_URL must be a URL");
  }
  if (appUrl && appUrl.protocol !== "https:" && !isLocalHost(appUrl.hostname)) {
    errors.push("APP_URL must use https:// (sessions use Secure cookies and browsers block mixed content)");
  }
  if (appUrl && appUrl.protocol === "https:" && !env.TRUST_PROXY) {
    warnings.push("TRUST_PROXY is off: behind a TLS-terminating proxy or load balancer, client IPs and rate limits will be wrong");
  }

  if (env.STORAGE_DRIVER !== "local" && (!env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY)) {
    errors.push(`STORAGE_DRIVER=${env.STORAGE_DRIVER} needs S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY`);
  }
  if (env.STORAGE_DRIVER === "local") warnings.push("STORAGE_DRIVER=local: keep STORAGE_LOCAL_DIR on a persistent, backed-up volume (and use one API instance)");

  if (env.SAAS_MODE && env.STRIPE_SECRET_KEY) {
    if (!env.STRIPE_WEBHOOK_SECRET) errors.push("STRIPE_WEBHOOK_SECRET is required with STRIPE_SECRET_KEY (subscriptions are updated by webhooks)");
    if (!env.STRIPE_PRICE_PRO) errors.push("STRIPE_PRICE_PRO is required with STRIPE_SECRET_KEY");
    if (env.STRIPE_SECRET_KEY.startsWith("sk_test_")) warnings.push("STRIPE_SECRET_KEY is a test-mode key");
  }

  if (!env.SMTP_URL) warnings.push("SMTP_URL is not set: emails (invitations, password resets, notifications) are only logged");
  else if (/@localhost>?$/.test(env.MAIL_FROM)) warnings.push("MAIL_FROM still uses @localhost; most mail servers will reject it");
  if (!env.REDIS_URL) warnings.push("REDIS_URL is not set: fine for one API instance; required for more (rate limits, live updates, caches)");
  if (!env.METRICS_TOKEN) warnings.push("METRICS_TOKEN is not set: /metrics is disabled");
  if (env.RATE_LIMIT_ALLOWLIST.trim()) warnings.push("RATE_LIMIT_ALLOWLIST is set: those IPs bypass rate limiting");

  return { errors, warnings };
}
