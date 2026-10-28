import { and, eq, gt, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { verify } from "@node-rs/argon2";
import { ARGON2_OPTIONS, getSystemContext, hashPassword, sessions, users } from "@lms/db";
import { z } from "zod";
import { clearSessionCookie, createSession, requireUser, setSessionCookie } from "../../core/auth";
import { audit } from "../../core/audit";
import { forbidden, must, unauthorized } from "../../core/errors";
import { emit } from "../../core/events";
import { queueMail } from "../../core/mail";
import { ok, zDate, zId, zOk } from "../../core/schemas";
import { config } from "../../config";
import {
  authenticate,
  consumeAuthToken,
  issueAuthToken,
  registerUser,
  revokeSessions,
  siteCapabilities,
  throwIfDeferred,
  zPassword,
} from "./service";
import { assertWithinLimits } from "../billing/service";
import { mfaEnrollmentRequired } from "../mfa/service";

const zMe = z.object({
  id: zId,
  email: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  locale: z.string(),
  timezone: z.string(),
});

const zCredentials = z.object({ email: z.string().email().max(320), password: z.string().min(1).max(200) });

/** Second step needed: POST /auth/mfa/verify with this token (5 minutes, single use). */
export const zMfaRequired = z.object({ mfaRequired: z.literal(true), challengeToken: z.string() });
const zLoginOk = z.object({ user: zMe, mfaEnrollmentRequired: z.boolean().optional() });

/** Strict limits on credential endpoints (brute force / credential stuffing). */
const authLimit = { rateLimit: { max: 10, timeWindow: "1 minute" } };

export const routes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    "/login",
    {
      config: authLimit,
      schema: {
        tags: ["Auth"],
        summary: "Sign in (sets httpOnly session cookie, or returns an MFA challenge)",
        body: zCredentials,
        response: { 200: z.union([zLoginOk, zMfaRequired]) },
      },
    },
    async (req, reply) => {
      const outcome = throwIfDeferred(await req.tenant((tx) => authenticate(tx, req, req.body.email, req.body.password)));
      if (outcome.kind === "mfa") return { mfaRequired: true as const, challengeToken: outcome.challengeToken };
      setSessionCookie(reply, outcome.token);
      return { user: outcome.user, ...(outcome.mfaEnrollmentRequired ? { mfaEnrollmentRequired: true } : {}) };
    },
  );

  app.post(
    "/token",
    {
      config: authLimit,
      schema: {
        tags: ["Auth"],
        summary: "Sign in and receive a bearer token (mobile / API clients), or an MFA challenge",
        body: zCredentials,
        response: { 200: z.union([z.object({ token: z.string(), user: zMe, mfaEnrollmentRequired: z.boolean().optional() }), zMfaRequired]) },
      },
    },
    async (req) => {
      const outcome = throwIfDeferred(await req.tenant((tx) => authenticate(tx, req, req.body.email, req.body.password)));
      if (outcome.kind === "mfa") return { mfaRequired: true as const, challengeToken: outcome.challengeToken };
      return { token: outcome.token, user: outcome.user, ...(outcome.mfaEnrollmentRequired ? { mfaEnrollmentRequired: true } : {}) };
    },
  );

  app.post("/logout", { schema: { tags: ["Auth"], summary: "Sign out this session", response: { 200: zOk } } }, async (req, reply) => {
    if (req.sessionId) {
      const sid = req.sessionId;
      await req.tenant((tx) => tx.delete(sessions).where(eq(sessions.id, sid)));
    }
    clearSessionCookie(reply);
    return ok;
  });

  app.post(
    "/logout-all",
    { schema: { tags: ["Auth"], summary: "Sign out every session of the current user", response: { 200: zOk } } },
    async (req, reply) => {
      const user = requireUser(req);
      await req.tenant((tx) => revokeSessions(tx, user.id));
      clearSessionCookie(reply);
      return ok;
    },
  );

  app.get(
    "/me",
    {
      schema: {
        tags: ["Auth"],
        summary: "Current user, organization and site-level capabilities",
        response: {
          200: z.object({
            user: zMe.nullable(),
            organization: z.object({ id: zId, name: z.string(), slug: z.string(), selfRegistration: z.boolean(), systemContextId: zId.nullable() }),
            capabilities: z.record(z.string(), z.boolean()),
            /** The organization requires MFA for administrators and this user hasn't enrolled yet. */
            mfaEnrollmentRequired: z.boolean(),
          }),
        },
      },
    },
    async (req) => {
      const user = req.user;
      const { capabilities, systemContextId, enrollmentRequired } = user
        ? await req.tenant(async (tx) => ({
            capabilities: await siteCapabilities(tx, req),
            systemContextId: (await getSystemContext(tx, req.org.id)).id,
            enrollmentRequired: await mfaEnrollmentRequired(tx, req.org, user.id),
          }))
        : { capabilities: {}, systemContextId: null, enrollmentRequired: false };
      return {
        user: req.user,
        organization: {
          id: req.org.id,
          name: req.org.name,
          slug: req.org.slug,
          selfRegistration: req.org.settings.selfRegistration === true,
          systemContextId,
        },
        capabilities: capabilities as Record<string, boolean>,
        mfaEnrollmentRequired: enrollmentRequired,
      };
    },
  );

  app.post(
    "/register",
    {
      config: authLimit,
      schema: {
        tags: ["Auth"],
        summary: "Self-registration (when enabled for the organization)",
        body: z.object({
          email: z.string().email().max(320),
          password: zPassword,
          firstName: z.string().trim().min(1).max(100),
          lastName: z.string().trim().min(1).max(100),
        }),
        response: { 201: z.object({ user: zMe }) },
      },
    },
    async (req, reply) => {
      if (req.org.settings.selfRegistration !== true) throw forbidden("Self-registration is disabled");
      const user = await req.tenant(async (tx) => {
        await assertWithinLimits(tx, req.org.id, "users");
        const created = await registerUser(tx, req, req.body);
        const token = await issueAuthToken(tx, { organizationId: req.org.id, userId: created.id, purpose: "email_verify", ttlMinutes: 60 * 24 });
        await queueMail(tx, req.org.id, {
            to: created.email,
            subject: `Confirm your email for ${req.org.name}`,
            text: `Confirm your email: ${config.APP_URL}/verify-email?token=${token}`,
          });
        return created;
      });
      await emit("user.created", { organizationId: req.org.id, userId: user.id });
      const token = await req.tenant((tx) => createSession(tx, req, user.id));
      setSessionCookie(reply, token);
      return reply.status(201).send({ user });
    },
  );

  app.post(
    "/verify-email",
    { schema: { tags: ["Auth"], summary: "Confirm email address", body: z.object({ token: z.string().min(10) }), response: { 200: zOk } } },
    async (req) => {
      await req.tenant(async (tx) => {
        const row = await consumeAuthToken(tx, req.body.token, "email_verify");
        await tx.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, row.userId));
      });
      return ok;
    },
  );

  app.post(
    "/password/forgot",
    {
      config: authLimit,
      schema: {
        tags: ["Auth"],
        summary: "Request a password reset email (always returns ok)",
        body: z.object({ email: z.string().email() }),
        response: { 200: zOk },
      },
    },
    async (req) => {
      await req.tenant(async (tx) => {
        const [user] = await tx
          .select()
          .from(users)
          .where(and(eq(sql`lower(${users.email})`, req.body.email.toLowerCase()), eq(users.status, "active")))
          .limit(1);
        if (!user) return;
        const token = await issueAuthToken(tx, { organizationId: req.org.id, userId: user.id, purpose: "password_reset", ttlMinutes: 30 });
        await queueMail(tx, req.org.id, {
            to: user.email,
            subject: "Reset your password",
            text: `Reset your password (valid for 30 minutes): ${config.APP_URL}/reset-password?token=${token}\n\nIf you did not request this, ignore this email.`,
          });
      });
      return ok;
    },
  );

  app.post(
    "/password/reset",
    {
      config: authLimit,
      schema: { tags: ["Auth"], summary: "Set a new password using a reset token", body: z.object({ token: z.string().min(10), password: zPassword }), response: { 200: zOk } },
    },
    async (req) => {
      await req.tenant(async (tx) => {
        const row = await consumeAuthToken(tx, req.body.token, "password_reset");
        await tx
          .update(users)
          .set({ passwordHash: await hashPassword(req.body.password), failedLoginCount: 0, lockedUntil: null })
          .where(eq(users.id, row.userId));
        await revokeSessions(tx, row.userId);
        await audit(tx, req, "auth.password_reset", { type: "user", id: row.userId });
      });
      return ok;
    },
  );

  app.post(
    "/password/change",
    {
      config: authLimit,
      schema: {
        tags: ["Auth"],
        summary: "Change password (signs out other sessions)",
        body: z.object({ currentPassword: z.string(), newPassword: zPassword }),
        response: { 200: zOk },
      },
    },
    async (req) => {
      const me = requireUser(req);
      await req.tenant(async (tx) => {
        const [user] = await tx.select().from(users).where(eq(users.id, me.id)).limit(1);
        const valid = user?.passwordHash && (await verify(user.passwordHash, req.body.currentPassword, ARGON2_OPTIONS).catch(() => false));
        if (!valid) throw unauthorized("Current password is incorrect");
        await tx.update(users).set({ passwordHash: await hashPassword(req.body.newPassword) }).where(eq(users.id, me.id));
        await revokeSessions(tx, me.id, req.sessionId);
        await audit(tx, req, "auth.password_changed", { type: "user", id: me.id });
      });
      return ok;
    },
  );

  app.get(
    "/sessions",
    {
      schema: {
        tags: ["Auth"],
        summary: "Active sessions of the current user",
        response: {
          200: z.array(z.object({ id: z.string(), current: z.boolean(), ip: z.string().nullable(), userAgent: z.string().nullable(), createdAt: zDate, lastSeenAt: zDate })),
        },
      },
    },
    async (req) => {
      const me = requireUser(req);
      const rows = await req.tenant((tx) =>
        tx.select().from(sessions).where(and(eq(sessions.userId, me.id), gt(sessions.expiresAt, new Date()))).orderBy(sessions.lastSeenAt),
      );
      // Expose a short, non-reversible handle — never the session hash itself.
      return rows.map((s) => ({
        id: s.id.slice(0, 16),
        current: s.id === req.sessionId,
        ip: s.ip,
        userAgent: s.userAgent,
        createdAt: s.createdAt,
        lastSeenAt: s.lastSeenAt,
      }));
    },
  );

  app.delete(
    "/sessions/:id",
    { schema: { tags: ["Auth"], summary: "Revoke one of your sessions", params: z.object({ id: z.string().length(16) }), response: { 200: zOk } } },
    async (req) => {
      const me = requireUser(req);
      await req.tenant(async (tx) => {
        const rows = await tx.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, me.id));
        const target = must(rows.find((r) => r.id.startsWith(req.params.id)), "Session");
        await tx.delete(sessions).where(eq(sessions.id, target.id));
      });
      return ok;
    },
  );
};
