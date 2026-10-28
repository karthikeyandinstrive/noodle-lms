import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

// Test IdPs listen on 127.0.0.1: allow private endpoints for this process (read when config loads).
vi.hoisted(() => {
  process.env.ALLOW_PRIVATE_STORAGE_ENDPOINTS = "true";
});

import { closeDb, organizations, ssoProviders, systemDb, userIdentities, userMfa, users, withTenant } from "@lms/db";
import { cache } from "../src/core/redis";
import { resolveAccount, sanitizeNext, SsoError } from "../src/modules/sso/service";
import { base32Decode, base32Encode, hotp, totp, verifyTotp, timeStep } from "../src/modules/mfa/totp";
import { Client, PASSWORD, setup, type TestEnv } from "./helpers";

const TEST_CERT =
  "MIIDCTCCAfGgAwIBAgIUEZLSP7B9Fm2gU/+ZihIBjd7a8cEwDQYJKoZIhvcNAQELBQAwEzERMA8GA1UEAwwIdGVzdC1pZHAwIBcNMjYxMDI4MDg0NjI1WhgPMjEyNjEwMDQwODQ2MjVaMBMxETAPBgNVBAMMCHRlc3QtaWRwMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxbMgcvr1PRWJCGV4D8iPf2HFc+EMNj2rH1FYC/AdDo+CORJE+ZzZ/OAzmzQG04sISxMvYf4HiIWOXNP6HQY51S/j7vPILVkQesnFIRIoy1OeXzFtWJ3HMwMriXVWca0i4IJFakctG37ePmhUTl273y3zH/WwZyCmy819ZMMbHueOMBp+a/+SBQaILvD39CRxwGX3wmc556+KIM5bnpEJ+bmZvjFf539fikEXnaszXKarVxj5/s1RbQpNY0MWr9UGcQ/AjBfnbwUTpqmy0Oc04+mWN38QIjXiJXbWlcaEzg6IZBafRF3BUhvfM5OmmPP8WFhdGSlk2sBqKVxZk1PO7QIDAQABo1MwUTAdBgNVHQ4EFgQUZjKlZk9voCKzj2rDSh2SeKg1JqIwHwYDVR0jBBgwFoAUZjKlZk9voCKzj2rDSh2SeKg1JqIwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEArqT6iwmog/QLOpic/CFIumu/fC7DSFRQnSTwpa6XBeHkRVYXmSljRZ4FxOzLfHRvmqSttH6le7wGPsrx6Xd8tEqBdHcngAHhSCLqzJ/Lk52HevbMH1s33Lfk5DodxAGvb8V9dWGx9KkgnFmkPsJiRY1IfZpA2Khlq4acaKEGMG29pmI9Ew2R41FwtH8EacgoqiPwFGtKkbvW1TXA1tyKfJXaTBx6qWRs6DAcp7G65qzWyNPfMe4Luthb6qmd6yFdlFAEh8hmDjtFpGcr4IpMR/kCejoAFVMaOXc35dwbxFOr6prlYtmKAK48wQf6R0jrMDulQXB9H5bxXlPXZQngQw==";

let env: TestEnv;
let admin: Client;
let ipCounter = 1;
/** A distinct client IP per credential request so the strict per-IP auth rate limits don't interfere. */
const freshIp = () => ({ "x-forwarded-for": `10.9.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}` });

async function createUser(email: string, by = admin) {
  const res = await by.req("POST", "/users", { email, firstName: "Test", lastName: "User", password: PASSWORD });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function login(c: Client, email: string, password = PASSWORD) {
  return c.req("POST", "/auth/login", { email, password }, freshIp());
}

const codeAt = (secret: string, offsetSteps = 0) => totp(base32Decode(secret), Date.now() + offsetSteps * 30_000);

async function enrollMfa(c: Client) {
  const setupRes = await c.req("POST", "/auth/mfa/setup", {});
  expect(setupRes.status).toBe(200);
  expect(setupRes.body.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
  expect(setupRes.body.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);
  const secret = setupRes.body.secret as string;
  const enable = await c.req("POST", "/auth/mfa/enable", { code: codeAt(secret) });
  expect(enable.status).toBe(200);
  return { secret, recoveryCodes: enable.body.recoveryCodes as string[] };
}

beforeAll(async () => {
  env = await setup();
  admin = new Client(env.app);
  expect((await login(admin, "admin@default.test")).status).toBe(200);
});

afterAll(async () => {
  await env.app.close();
  await closeDb();
});

// ─── TOTP primitives ────────────────────────────────────────────────────────

describe("TOTP (RFC 6238)", () => {
  // RFC 6238 Appendix B, SHA-1, 8 digits, seed "12345678901234567890".
  const seed = Buffer.from("12345678901234567890", "ascii");
  const vectors: [number, string][] = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];

  it("matches the RFC 6238 SHA-1 test vectors", () => {
    for (const [t, expected] of vectors) expect(totp(seed, t * 1000, { digits: 8 })).toBe(expected);
  });

  it("matches the RFC 4226 HOTP vectors (6 digits)", () => {
    expect([0, 1, 2, 9].map((c) => hotp(seed, c))).toEqual(["755224", "287082", "359152", "520489"]);
  });

  it("round-trips base32", () => {
    expect(base32Encode(seed)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32Decode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ").equals(seed)).toBe(true);
  });

  it("accepts ±1 step, rejects older codes and replays", () => {
    const secret = base32Encode(seed);
    const now = 1_700_000_000_000;
    const step = timeStep(now);
    expect(verifyTotp(secret, totp(seed, now), { timeMs: now })).toBe(step);
    expect(verifyTotp(secret, totp(seed, now - 30_000), { timeMs: now })).toBe(step - 1);
    expect(verifyTotp(secret, totp(seed, now + 30_000), { timeMs: now })).toBe(step + 1);
    expect(verifyTotp(secret, totp(seed, now - 90_000), { timeMs: now })).toBeNull();
    expect(verifyTotp(secret, totp(seed, now), { timeMs: now, lastUsedStep: step })).toBeNull();
    expect(verifyTotp(secret, "12ab56", { timeMs: now })).toBeNull();
  });
});

describe("next redirect sanitizer", () => {
  it("keeps same-site relative paths", () => {
    expect(sanitizeNext("/courses/1?tab=grades#top")).toBe("/courses/1?tab=grades#top");
    expect(sanitizeNext("/dashboard")).toBe("/dashboard");
  });
  it.each([
    undefined,
    "",
    "https://evil.example/x",
    "//evil.example",
    "/\\evil.example",
    "\\\\evil.example",
    "javascript:alert(1)",
    "courses/1",
    "/\tevil",
    "/%0d%0aSet-Cookie:x",
    "x".repeat(2000),
  ])("rejects %s", (value) => {
    const out = sanitizeNext(value);
    expect(out.startsWith("/")).toBe(true);
    expect(out.startsWith("//")).toBe(false);
    if (value !== "/%0d%0aSet-Cookie:x") expect(out).toBe("/dashboard");
    // Encoded CR/LF stays encoded: harmless in a Location path.
    else expect(out).toBe("/%0d%0aSet-Cookie:x");
  });
});

// ─── MFA ────────────────────────────────────────────────────────────────────

describe("MFA sign-in", () => {
  const email = "mfa-user@default.test";
  let user: Client;
  let userId: string;
  let secret: string;
  let recoveryCodes: string[];

  beforeAll(async () => {
    userId = await createUser(email);
    user = new Client(env.app);
    expect((await login(user, email)).status).toBe(200);
    expect((await user.req("GET", "/auth/mfa/status")).body).toMatchObject({ enabled: false, pending: false });
    ({ secret, recoveryCodes } = await enrollMfa(user));
    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);
  });

  it("stores only hashes of recovery codes and an encrypted secret", async () => {
    const db = await systemDb();
    const [row] = await db.select().from(userMfa).where(eq(userMfa.userId, userId));
    expect(row!.enabledAt).not.toBeNull();
    expect(row!.totpSecretEnc).not.toContain(secret);
    for (const code of recoveryCodes) expect(row!.recoveryCodeHashes).not.toContain(code);
    expect((await user.req("GET", "/auth/mfa/status")).body).toMatchObject({ enabled: true, recoveryCodesRemaining: 10 });
  });

  it("password login returns a challenge instead of a session", async () => {
    const c = new Client(env.app);
    const res = await login(c, email);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mfaRequired: true, challengeToken: expect.any(String) });
    expect(c.cookie).toBe("");
    expect((await c.req("GET", "/auth/me")).body.user).toBeNull();
  });

  it("rejects a replayed code and accepts the next one, then the challenge is single use", async () => {
    const c = new Client(env.app);
    const { challengeToken } = (await login(c, email)).body;
    // The enrollment code's step is already used.
    const replay = await c.req("POST", "/auth/mfa/verify", { challengeToken, code: codeAt(secret) }, freshIp());
    expect(replay.status).toBe(401);
    const next = codeAt(secret, 1);
    const ok = await c.req("POST", "/auth/mfa/verify", { challengeToken, code: next }, freshIp());
    expect(ok.status).toBe(200);
    expect(ok.body.user.email).toBe(email);
    expect((await c.req("GET", "/auth/me")).body.user.email).toBe(email);

    // Same challenge again → invalid, even with a recovery code.
    const again = await new Client(env.app).req("POST", "/auth/mfa/verify", { challengeToken, recoveryCode: recoveryCodes[5] }, freshIp());
    expect(again.status).toBe(401);
    expect(again.body.error.code).toBe("MFA_CHALLENGE_INVALID");

    // Same code with a fresh challenge → replay.
    const c2 = new Client(env.app);
    const t2 = (await login(c2, email)).body.challengeToken;
    expect((await c2.req("POST", "/auth/mfa/verify", { challengeToken: t2, code: next }, freshIp())).status).toBe(401);
  });

  it("recovery codes are single use", async () => {
    const c = new Client(env.app);
    const t1 = (await login(c, email)).body.challengeToken;
    const first = await c.req("POST", "/auth/mfa/verify", { challengeToken: t1, recoveryCode: recoveryCodes[0]!.toUpperCase() }, freshIp());
    expect(first.status).toBe(200);
    const c2 = new Client(env.app);
    const t2 = (await login(c2, email)).body.challengeToken;
    expect((await c2.req("POST", "/auth/mfa/verify", { challengeToken: t2, recoveryCode: recoveryCodes[0] }, freshIp())).status).toBe(401);
    expect((await user.req("GET", "/auth/mfa/status")).body.recoveryCodesRemaining).toBe(9);
  });

  it("issues a bearer token with ?mode=token via /auth/token", async () => {
    const res = await new Client(env.app).req("POST", "/auth/token", { email, password: PASSWORD }, freshIp());
    expect(res.body.mfaRequired).toBe(true);
    const verify = await new Client(env.app).req("POST", "/auth/mfa/verify?mode=token", { challengeToken: res.body.challengeToken, recoveryCode: recoveryCodes[1] }, freshIp());
    expect(verify.status).toBe(200);
    expect(typeof verify.body.token).toBe("string");
    const me = await env.app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { host: "localhost", authorization: `Bearer ${verify.body.token}` } });
    expect(JSON.parse(me.body).user.email).toBe(email);
  });

  it("wrong codes count towards the shared lockout counter", async () => {
    const db = await systemDb();
    const before = (await db.select().from(users).where(eq(users.id, userId)))[0]!.failedLoginCount;
    const c = new Client(env.app);
    const t = (await login(c, email)).body.challengeToken;
    const bad = await c.req("POST", "/auth/mfa/verify", { challengeToken: t, code: "000000" === codeAt(secret) ? "111111" : "000000" }, freshIp());
    expect(bad.status).toBe(401);
    const after = (await db.select().from(users).where(eq(users.id, userId)))[0]!.failedLoginCount;
    expect(after).toBe(before + 1);
    // A wrong password counts too (and persists despite the error response).
    expect((await login(new Client(env.app), email, "wrong-password1")).status).toBe(401);
    expect((await db.select().from(users).where(eq(users.id, userId)))[0]!.failedLoginCount).toBe(before + 2);
  });

  it("regenerates recovery codes and disables with the password", async () => {
    expect((await user.req("POST", "/auth/mfa/recovery-codes/regenerate", { password: "wrong-password1" })).status).toBe(400);
    const regen = await user.req("POST", "/auth/mfa/recovery-codes/regenerate", { password: PASSWORD });
    expect(regen.status).toBe(200);
    expect(regen.body.recoveryCodes).toHaveLength(10);
    expect(regen.body.recoveryCodes).not.toContain(recoveryCodes[2]);
    expect((await user.req("POST", "/auth/mfa/disable", { password: PASSWORD })).status).toBe(200);
    expect((await user.req("GET", "/auth/mfa/status")).body.enabled).toBe(false);
    const res = await login(new Client(env.app), email);
    expect(res.body.user.email).toBe(email);

    const db = await systemDb();
    const audits = await db.query.auditLogs.findMany({ where: (a, { eq: e }) => e(a.targetId, userId) });
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(["mfa.enabled", "mfa.recovery_code_used", "mfa.recovery_codes_regenerated", "mfa.disabled"]));
  });
});

describe("MFA enrollment policy for administrators", () => {
  let acmeAdmin: Client;

  beforeAll(async () => {
    const db = await systemDb();
    const [org] = await db.select().from(organizations).where(eq(organizations.id, env.orgs.acme!.id));
    await db.update(organizations).set({ settings: { ...org!.settings, requireMfaForAdmins: true } }).where(eq(organizations.id, org!.id));
    await cache.del("org:host:acme.localhost");
    acmeAdmin = new Client(env.app, "acme.localhost");
  });

  it("returns a restricted session that only reaches /auth/me, /auth/mfa/* and logout", async () => {
    const res = await login(acmeAdmin, "admin@acme.test");
    expect(res.status).toBe(200);
    expect(res.body.mfaEnrollmentRequired).toBe(true);
    const me = await acmeAdmin.req("GET", "/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.mfaEnrollmentRequired).toBe(true);
    const blocked = await acmeAdmin.req("GET", "/users");
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("MFA_ENROLLMENT_REQUIRED");
    expect((await acmeAdmin.req("GET", "/auth/mfa/status")).body.required).toBe(true);
  });

  it("does not restrict non-admin users", async () => {
    const id = await createUserIn("acme", "learner@acme.test");
    expect(id).toBeTruthy();
  });

  it("unlocks the session as soon as the admin enrolls", async () => {
    await enrollMfa(acmeAdmin);
    expect((await acmeAdmin.req("GET", "/users")).status).toBe(200);
    expect((await acmeAdmin.req("GET", "/auth/me")).body.mfaEnrollmentRequired).toBe(false);
  });

  async function createUserIn(_org: "acme", email: string) {
    // Created by the (temporarily restricted) admin after enrollment would also work; use the DB directly here.
    const db = await systemDb();
    const [u] = await db
      .insert(users)
      .values({ organizationId: env.orgs.acme!.id, email, firstName: "L", lastName: "Earner", passwordHash: (await db.select().from(users).where(eq(users.email, "admin@acme.test")))[0]!.passwordHash })
      .returning();
    const c = new Client(env.app, "acme.localhost");
    const res = await login(c, email);
    expect(res.status).toBe(200);
    expect(res.body.mfaEnrollmentRequired).toBeUndefined();
    expect((await c.req("GET", "/courses")).status).not.toBe(403);
    return u!.id;
  }
});

// ─── SSO ────────────────────────────────────────────────────────────────────

describe("SSO provider administration", () => {
  it("creates OIDC providers with an encrypted, masked secret", async () => {
    const res = await admin.req("POST", "/sso/providers", {
      type: "oidc",
      slug: "corp",
      name: "Corp IdP",
      oidc: { issuer: "https://127.0.0.1:1", clientId: "lms", clientSecret: "super-secret-value-1234" },
    });
    expect(res.status).toBe(201);
    expect(res.body.oidc.clientSecret).toBe("••••1234");
    expect(JSON.stringify(res.body)).not.toContain("super-secret-value");
    expect(res.body.urls.callback).toBe("http://localhost/api/v1/sso/corp/callback");
    const db = await systemDb();
    const [row] = await db.select().from(ssoProviders).where(eq(ssoProviders.id, res.body.id));
    expect(JSON.stringify(row!.config)).not.toContain("super-secret-value");

    // Disabled providers aren't public.
    expect((await new Client(env.app).req("GET", "/sso/providers")).body).toEqual([]);
    const patched = await admin.req("PATCH", `/sso/providers/${res.body.id}`, { enabled: true, oidc: { clientId: "lms2" } });
    expect(patched.status).toBe(200);
    expect(patched.body.oidc).toMatchObject({ clientId: "lms2", clientSecret: "••••1234" });
    expect((await new Client(env.app).req("GET", "/sso/providers")).body).toEqual([{ slug: "corp", name: "Corp IdP", type: "oidc", enforced: false }]);
    expect((await admin.req("DELETE", `/sso/providers/${res.body.id}`)).status).toBe(200);
  });

  it("requires site:manage_sso", async () => {
    await createUser("plain@default.test");
    const c = new Client(env.app);
    await login(c, "plain@default.test");
    expect((await c.req("GET", "/sso/providers/manage")).status).toBe(403);
    expect((await c.req("POST", "/sso/providers", { type: "saml", slug: "x", name: "X", saml: { entryPoint: "https://127.0.0.1/sso", idpCert: TEST_CERT } })).status).toBe(403);
  });

  it("validates SAML certificates and serves SP metadata", async () => {
    const bad = await admin.req("POST", "/sso/providers", { type: "saml", slug: "bad", name: "Bad", saml: { entryPoint: "https://127.0.0.1/sso", idpCert: "x".repeat(200) } });
    expect(bad.status).toBe(400);
    const res = await admin.req("POST", "/sso/providers", {
      type: "saml",
      slug: "adfs",
      name: "ADFS",
      enabled: true,
      saml: { entryPoint: "https://127.0.0.1/adfs/ls", idpCert: `-----BEGIN CERTIFICATE-----\n${TEST_CERT}\n-----END CERTIFICATE-----` },
    });
    expect(res.status).toBe(201);
    expect(res.body.urls.acs).toBe("http://localhost/api/v1/sso/adfs/acs");
    expect((await admin.req("POST", `/sso/providers/${res.body.id}/test`, {})).body.ok).toBe(true);
    const meta = await env.app.inject({ method: "GET", url: "/api/v1/sso/adfs/metadata", headers: { host: "localhost" } });
    expect(meta.statusCode).toBe(200);
    expect(meta.headers["content-type"]).toContain("xml");
    expect(meta.body).toContain('Location="http://localhost/api/v1/sso/adfs/acs"');

    const start = await env.app.inject({ method: "GET", url: "/api/v1/sso/adfs/login?next=/courses", headers: { host: "localhost" } });
    expect(start.statusCode).toBe(302);
    expect(start.headers.location).toMatch(/^https:\/\/127\.0\.0\.1\/adfs\/ls\?SAMLRequest=.+&RelayState=/);
  });

  it("the SAML ACS bypasses the CSRF origin check but rejects forged responses", async () => {
    const res = await env.app.inject({
      method: "POST",
      url: "/api/v1/sso/adfs/acs",
      headers: { host: "localhost", origin: "https://idp.example", cookie: admin.cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ SAMLResponse: Buffer.from("<samlp:Response/>").toString("base64"), RelayState: "forged" }).toString(),
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/login?error=sso_state");
    // No session was created.
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("redirects unknown providers to the login page with an error code", async () => {
    const res = await env.app.inject({ method: "GET", url: "/api/v1/sso/nope/login", headers: { host: "localhost" } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/login?error=sso_unavailable");
  });
});

describe("OIDC sign-in (mock identity provider)", () => {
  let server: Server;
  let issuer: string;
  let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
  let jwk: Record<string, unknown>;
  const pending = new Map<string, { nonce: string; challenge: string }>();
  let nextClaims: Record<string, unknown> = {};

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    privateKey = pair.privateKey;
    jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
    server = createServer(async (req, res) => {
      const url = new URL(req.url!, issuer);
      const json = (body: unknown) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(body));
      };
      if (url.pathname === "/.well-known/openid-configuration") {
        return json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (url.pathname === "/jwks") return json({ keys: [jwk] });
      if (url.pathname === "/token") {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const form = new URLSearchParams(raw);
        const p = pending.get(form.get("code")!);
        const verifier = form.get("code_verifier") ?? "";
        if (!p || createHash("sha256").update(verifier).digest("base64url") !== p.challenge) {
          res.statusCode = 400;
          return json({ error: "invalid_grant" });
        }
        const idToken = await new SignJWT({ nonce: p.nonce, ...nextClaims })
          .setProtectedHeader({ alg: "RS256", kid: "k1" })
          .setIssuer(issuer)
          .setAudience("lms-client")
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(privateKey);
        return json({ access_token: "at", token_type: "Bearer", expires_in: 300, id_token: idToken });
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const created = await admin.req("POST", "/sso/providers", {
      type: "oidc",
      slug: "mock",
      name: "Mock",
      enabled: true,
      autoProvision: true,
      allowedDomains: ["mock.test"],
      oidc: { issuer, clientId: "lms-client", clientSecret: "mock-secret" },
    });
    expect(created.status).toBe(201);
  });

  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  async function signIn(claims: Record<string, unknown>, next = "/courses/abc") {
    nextClaims = claims;
    const start = await env.app.inject({ method: "GET", url: `/api/v1/sso/mock/login?next=${encodeURIComponent(next)}`, headers: { host: "localhost" } });
    expect(start.statusCode).toBe(302);
    const authorize = new URL(start.headers.location as string);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    const stateCookie = ([] as string[]).concat(start.headers["set-cookie"] ?? []).find((c) => c.startsWith("lms_sso_state="))!;
    expect(stateCookie).toMatch(/HttpOnly/i);
    expect(stateCookie).toMatch(/SameSite=Lax/i);
    const code = `code-${Math.random()}`;
    pending.set(code, { nonce: authorize.searchParams.get("nonce")!, challenge: authorize.searchParams.get("code_challenge")! });
    return env.app.inject({
      method: "GET",
      url: `/api/v1/sso/mock/callback?code=${code}&state=${authorize.searchParams.get("state")}`,
      headers: { host: "localhost", cookie: stateCookie.split(";")[0]! },
    });
  }

  it("provisions a new user and redirects to next", async () => {
    const res = await signIn({ sub: "u-1", email: "New.Person@mock.test", email_verified: true, given_name: "New", family_name: "Person" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/courses/abc");
    const session = ([] as string[]).concat(res.headers["set-cookie"] ?? []).find((c) => c.startsWith("lms_session="));
    expect(session).toBeDefined();
    const me = await env.app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { host: "localhost", cookie: session!.split(";")[0]! } });
    expect(JSON.parse(me.body).user).toMatchObject({ email: "new.person@mock.test", firstName: "New" });
    const db = await systemDb();
    const audits = await db.query.auditLogs.findMany({ where: (a, { inArray }) => inArray(a.action, ["sso.login", "sso.provisioned"]) });
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(["sso.login", "sso.provisioned"]));
  });

  it("rejects an unverified email and a callback without the state cookie", async () => {
    const res = await signIn({ sub: "u-2", email: "x@mock.test", email_verified: false });
    expect(res.headers.location).toBe("/login?error=sso_email_unverified");
    const noState = await env.app.inject({ method: "GET", url: "/api/v1/sso/mock/callback?code=x&state=y", headers: { host: "localhost" } });
    expect(noState.headers.location).toBe("/login?error=sso_state");
  });

  it("sanitizes an absolute next", async () => {
    const res = await signIn({ sub: "u-1", email: "new.person@mock.test", email_verified: true }, "https://evil.example/");
    expect(res.headers.location).toBe("/dashboard");
  });
});

describe("account resolution", () => {
  const orgId = () => env.orgs.default!.id;
  let provider: { id: string; allowedDomains: string[]; autoProvision: boolean };

  beforeAll(async () => {
    const res = await admin.req("POST", "/sso/providers", {
      type: "saml",
      slug: "resolver",
      name: "Resolver",
      saml: { entryPoint: "https://127.0.0.1/sso", idpCert: TEST_CERT },
    });
    provider = { id: res.body.id, allowedDomains: ["default.test"], autoProvision: false };
  });

  const resolve = (identity: Parameters<typeof resolveAccount>[3], p = provider) => withTenant(orgId(), (tx) => resolveAccount(tx, orgId(), p, identity));
  const code = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      return "ok";
    } catch (err) {
      if (err instanceof SsoError) return err.code;
      throw err;
    }
  };

  it("links an existing user by case-insensitive email when the domain is allowed, then reuses the link", async () => {
    const userId = await createUser("linkme@default.test");
    const first = await resolve({ subject: "s-1", email: "LinkMe@Default.test", emailVerified: true });
    expect(first).toMatchObject({ userId, linked: true, provisioned: false });
    // Subject wins over email on later logins.
    const second = await resolve({ subject: "s-1", email: "linkme@default.test", emailVerified: true });
    expect(second).toMatchObject({ userId, linked: false });
    const db = await systemDb();
    expect(await db.select().from(userIdentities).where(and(eq(userIdentities.providerId, provider.id), eq(userIdentities.subject, "s-1")))).toHaveLength(1);
  });

  it("refuses other domains, unverified emails and missing accounts", async () => {
    expect(await code(() => resolve({ subject: "s-2", email: "admin@acme.test", emailVerified: true }))).toBe("sso_domain_not_allowed");
    expect(await code(() => resolve({ subject: "s-3", email: "linkme@default.test", emailVerified: false }))).toBe("sso_email_unverified");
    expect(await code(() => resolve({ subject: "s-4", email: "ghost@default.test", emailVerified: true }))).toBe("sso_no_account");
    expect(await code(() => resolve({ subject: "s-5", email: null }))).toBe("sso_email_missing");
    // email_verified absent: only accepted for an explicitly allowed domain.
    expect(await code(() => resolve({ subject: "s-6", email: "nobody@other.test" }, { ...provider, allowedDomains: [] }))).toBe("sso_email_unverified");
    expect(await code(() => resolve({ subject: "s-7", email: "ghost@default.test" }))).toBe("sso_no_account");
  });

  it("auto-provisions only when enabled, and rejects suspended users", async () => {
    const created = await resolve({ subject: "s-8", email: "fresh@default.test", emailVerified: true, firstName: "Fresh" }, { ...provider, autoProvision: true });
    expect(created.provisioned).toBe(true);
    const db = await systemDb();
    const [u] = await db.select().from(users).where(eq(users.id, created.userId));
    expect(u).toMatchObject({ status: "active", passwordHash: null, firstName: "Fresh" });
    expect(u!.emailVerifiedAt).not.toBeNull();

    await db.update(users).set({ status: "suspended" }).where(eq(users.id, created.userId));
    expect(await code(() => resolve({ subject: "s-8", email: "fresh@default.test", emailVerified: true }))).toBe("sso_account_inactive");
  });
});

describe("enforced SSO", () => {
  it("rejects password login for non-admins but keeps break-glass for org admins", async () => {
    await createUser("enforced@default.test");
    const db = await systemDb();
    await db.update(ssoProviders).set({ enabled: true, enforced: true }).where(and(eq(ssoProviders.organizationId, env.orgs.default!.id), eq(ssoProviders.slug, "mock")));
    expect((await new Client(env.app).req("GET", "/sso/providers")).body.some((p: { enforced: boolean }) => p.enforced)).toBe(true);

    const blocked = await login(new Client(env.app), "enforced@default.test");
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("SSO_REQUIRED");
    const token = await new Client(env.app).req("POST", "/auth/token", { email: "enforced@default.test", password: PASSWORD }, freshIp());
    expect(token.status).toBe(403);
    // A wrong password still says "invalid" (doesn't reveal who is an admin).
    expect((await login(new Client(env.app), "enforced@default.test", "wrong-password1")).status).toBe(401);
    expect((await login(new Client(env.app), "admin@default.test")).status).toBe(200);
  });
});
