import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { productionProblems, type ProductionEnv } from "./production-check";

const good: ProductionEnv = {
  APP_URL: "https://learn.example.org",
  ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  URL_SIGNING_SECRET: randomBytes(48).toString("base64url"),
  DATABASE_URL: "postgresql://app@db/lms",
  REDIS_URL: "redis://cache:6379",
  SMTP_URL: "smtp://mail:587",
  MAIL_FROM: "LMS <no-reply@example.org>",
  METRICS_TOKEN: randomBytes(32).toString("base64url"),
  STORAGE_DRIVER: "s3",
  S3_BUCKET: "lms",
  S3_ACCESS_KEY_ID: "id",
  S3_SECRET_ACCESS_KEY: "secret",
  SAAS_MODE: false,
  TRUST_PROXY: true,
  RATE_LIMIT_ALLOWLIST: "",
};

describe("production configuration check", () => {
  it("accepts a complete configuration without warnings", () => {
    expect(productionProblems(good)).toEqual({ errors: [], warnings: [] });
  });

  it("rejects missing, short or placeholder secrets", () => {
    expect(productionProblems({ ...good, ENCRYPTION_KEY: undefined }).errors).toContain("ENCRYPTION_KEY is required");
    expect(productionProblems({ ...good, ENCRYPTION_KEY: Buffer.alloc(16, 1).toString("base64") }).errors[0]).toMatch(/32 random bytes/);
    expect(productionProblems({ ...good, ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") }).errors[0]).toMatch(/placeholder/);
    expect(productionProblems({ ...good, URL_SIGNING_SECRET: "dev-url-signing-secret-that-is-long-enough" }).errors[0]).toMatch(/placeholder/);
    expect(productionProblems({ ...good, URL_SIGNING_SECRET: "short" }).errors[0]).toMatch(/at least 32/);
  });

  it("requires https except on localhost, and a database", () => {
    expect(productionProblems({ ...good, APP_URL: "http://learn.example.org" }).errors[0]).toMatch(/https/);
    expect(productionProblems({ ...good, APP_URL: "http://localhost:3000" }).errors).toEqual([]);
    expect(productionProblems({ ...good, DATABASE_URL: undefined }).errors[0]).toMatch(/DATABASE_URL/);
  });

  it("checks storage and Stripe settings that go together", () => {
    expect(productionProblems({ ...good, S3_BUCKET: undefined }).errors[0]).toMatch(/S3_BUCKET/);
    const stripe = productionProblems({ ...good, SAAS_MODE: true, STRIPE_SECRET_KEY: "sk_test_x" });
    expect(stripe.errors).toEqual(expect.arrayContaining([expect.stringMatching(/STRIPE_WEBHOOK_SECRET/), expect.stringMatching(/STRIPE_PRICE_PRO/)]));
    expect(stripe.warnings.join(" ")).toMatch(/test-mode/);
  });

  it("warns about settings that degrade production", () => {
    const w = productionProblems({ ...good, SMTP_URL: undefined, REDIS_URL: undefined, METRICS_TOKEN: undefined, STORAGE_DRIVER: "local", TRUST_PROXY: false }).warnings.join(" ");
    for (const k of ["SMTP_URL", "REDIS_URL", "METRICS_TOKEN", "STORAGE_DRIVER=local", "TRUST_PROXY"]) expect(w).toContain(k);
  });
});
