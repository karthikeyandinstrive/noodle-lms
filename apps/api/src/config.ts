import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.string().default("info"),

  /** Public URL of the web app; used for CORS/CSRF origin checks and links in emails. */
  APP_URL: z.string().url().default("http://localhost:3000"),
  /** Extra allowed origins (comma separated), e.g. a mobile web-view origin. */
  ALLOWED_ORIGINS: z.string().default(""),
  TRUST_PROXY: bool,

  /** Base domain for SaaS subdomains: <slug>.BASE_DOMAIN */
  BASE_DOMAIN: z.string().default("localhost"),
  /** Organization used when the host matches no tenant (self-hosted mode). */
  DEFAULT_ORG_SLUG: z.string().default("default"),
  /** Allow public organization signup (SaaS mode). */
  SAAS_MODE: bool,

  /** 32-byte key, base64. Encrypts stored secrets (storage + payment credentials). */
  ENCRYPTION_KEY: z.string().optional(),
  /** Signs local-storage URLs. */
  URL_SIGNING_SECRET: z.string().optional(),

  SESSION_IDLE_MINUTES: z.coerce.number().default(60 * 24),
  SESSION_ABSOLUTE_DAYS: z.coerce.number().default(14),

  REDIS_URL: z.string().optional(),

  STORAGE_DRIVER: z.enum(["local", "s3", "minio", "r2"]).default("local"),
  STORAGE_LOCAL_DIR: z.string().default("storage"),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default("auto"),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  /** Self-hosted MinIO on a private network needs this; keep false in SaaS. */
  ALLOW_PRIVATE_STORAGE_ENDPOINTS: bool,

  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default("LMS <no-reply@localhost>"),

  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_PRO: z.string().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const env = parsed.data;

if (env.NODE_ENV === "production") {
  for (const key of ["ENCRYPTION_KEY", "URL_SIGNING_SECRET"] as const) {
    if (!env[key]) throw new Error(`${key} is required in production`);
  }
}

export const config = {
  ...env,
  isProd: env.NODE_ENV === "production",
  // Development-only fallbacks so `npm run dev` works without a .env file.
  ENCRYPTION_KEY: env.ENCRYPTION_KEY ?? Buffer.alloc(32, 7).toString("base64"),
  URL_SIGNING_SECRET: env.URL_SIGNING_SECRET ?? "dev-url-signing-secret",
  allowedOrigins: [env.APP_URL, ...env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)],
};

export type Config = typeof config;
