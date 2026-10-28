import { verify } from "@node-rs/argon2";
import { and, eq, gt, isNull, ne, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { ARGON2_OPTIONS, authTokens, getSystemContext, hashPassword, sessions, users, type DB } from "@lms/db";
import { z } from "zod";
import { createSession } from "../../core/auth";
import { randomToken, sha256 } from "../../core/crypto";
import { AppError, badRequest, unauthorized } from "../../core/errors";
import { capabilityMap } from "../../core/rbac";
import { getEnabledMfa, hasSystemRole, issueMfaChallenge, mfaEnrollmentRequired } from "../mfa/service";
import { isSsoEnforced } from "../sso/service";

export const zPassword = z
  .string()
  .min(10, "Use at least 10 characters")
  .max(200)
  .refine((p) => /[a-zA-Z]/.test(p) && /\d/.test(p), "Use letters and numbers");

const MAX_FAILED = 10;
const LOCK_MINUTES = 15;

// Verifying against a fixed hash when the user does not exist keeps response time constant (no user enumeration).
let dummyHash: Promise<string> | undefined;

type UserRow = typeof users.$inferSelect;

export type LoginOutcome =
  | { kind: "session"; user: UserRow; token: string; mfaEnrollmentRequired: boolean }
  | { kind: "mfa"; user: UserRow; challengeToken: string };

/**
 * Errors that must be raised *after* the transaction commits (so the
 * failed-attempt counter is persisted instead of rolled back). Use with
 * `throwIfDeferred(await req.tenant(...))`.
 */
export class DeferredError {
  constructor(public readonly error: AppError) {}
}
export function throwIfDeferred<T>(value: T | DeferredError): T {
  if (value instanceof DeferredError) throw value.error;
  return value;
}

export const accountLocked = () => new AppError(423, "ACCOUNT_LOCKED", "Too many failed attempts. Try again later.");
export const isLocked = (user: Pick<UserRow, "lockedUntil">) => !!user.lockedUntil && user.lockedUntil > new Date();

/** Counts a failed password or MFA attempt; locks the account after MAX_FAILED (shared counter). */
export async function recordFailedLogin(tx: DB, user: Pick<UserRow, "id" | "failedLoginCount">) {
  const failed = user.failedLoginCount + 1;
  await tx
    .update(users)
    .set({ failedLoginCount: failed, lockedUntil: failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null })
    .where(eq(users.id, user.id));
}

/** Successful sign-in: reset the counter and create a session. */
export async function completeLogin(tx: DB, req: FastifyRequest, userId: string) {
  await tx.update(users).set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() }).where(eq(users.id, userId));
  return createSession(tx, req, userId);
}

/**
 * Password step of sign-in.
 *  - SSO enforced → only org admins may use a password (break-glass).
 *  - MFA enabled → no session; returns a single-use challenge token for POST /auth/mfa/verify.
 *    The failed-attempt counter is NOT reset until the second factor succeeds.
 *  - Org policy requires MFA for admins and this admin has none → a session that the
 *    enrollment gate (see ./index.ts) restricts to /auth/me, /auth/mfa/* and logout.
 */
export async function authenticate(tx: DB, req: FastifyRequest, email: string, password: string): Promise<LoginOutcome | DeferredError> {
  const [user] = await tx
    .select()
    .from(users)
    .where(and(eq(sql`lower(${users.email})`, email.toLowerCase()), isNull(users.deletedAt)))
    .limit(1);

  if (!user?.passwordHash) {
    dummyHash ??= hashPassword("dummy-password-1");
    await verify(await dummyHash, password, ARGON2_OPTIONS).catch(() => false);
    throw unauthorized("Invalid email or password");
  }
  if (isLocked(user)) throw accountLocked();
  const valid = await verify(user.passwordHash, password, ARGON2_OPTIONS).catch(() => false);
  if (!valid) {
    await recordFailedLogin(tx, user);
    return new DeferredError(unauthorized("Invalid email or password"));
  }
  if (user.status !== "active") throw new AppError(403, "ACCOUNT_SUSPENDED", "This account is not active");

  // Checked after the password so the response doesn't reveal who is an admin.
  if ((await isSsoEnforced(tx)) && !(await hasSystemRole(tx, req.org.id, user.id, ["org_admin"]))) {
    throw new AppError(403, "SSO_REQUIRED", "Sign in with your organization's single sign-on provider.");
  }

  if (await getEnabledMfa(tx, user.id)) {
    const challengeToken = await issueMfaChallenge(tx, req.org.id, user.id);
    return { kind: "mfa", user, challengeToken };
  }

  const token = await completeLogin(tx, req, user.id);
  return { kind: "session", user, token, mfaEnrollmentRequired: await mfaEnrollmentRequired(tx, req.org, user.id) };
}

export async function registerUser(
  tx: DB,
  req: FastifyRequest,
  input: { email: string; password: string; firstName: string; lastName: string },
) {
  const [user] = await tx
    .insert(users)
    .values({
      organizationId: req.org.id,
      email: input.email.toLowerCase(),
      passwordHash: await hashPassword(input.password),
      firstName: input.firstName,
      lastName: input.lastName,
    })
    .returning();
  return user!;
}

/** Issues a single-use token (stored hashed). Returns the raw token for the email link. */
export async function issueAuthToken(
  tx: DB,
  input: { organizationId: string; userId: string; purpose: "password_reset" | "email_verify" | "invite"; ttlMinutes: number },
) {
  const token = randomToken(32);
  await tx.insert(authTokens).values({
    organizationId: input.organizationId,
    userId: input.userId,
    purpose: input.purpose,
    tokenHash: sha256(token),
    expiresAt: new Date(Date.now() + input.ttlMinutes * 60_000),
  });
  return token;
}

export async function consumeAuthToken(tx: DB, token: string, purpose: "password_reset" | "email_verify" | "invite") {
  const [row] = await tx
    .select()
    .from(authTokens)
    .where(
      and(
        eq(authTokens.tokenHash, sha256(token)),
        eq(authTokens.purpose, purpose),
        isNull(authTokens.usedAt),
        gt(authTokens.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (!row) throw badRequest("This link is invalid or has expired");
  await tx.update(authTokens).set({ usedAt: new Date() }).where(eq(authTokens.id, row.id));
  return row;
}

/** Revokes every session of a user, optionally keeping the current one. */
export async function revokeSessions(tx: DB, userId: string, keepSessionId?: string | null) {
  await tx
    .delete(sessions)
    .where(keepSessionId ? and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId)) : eq(sessions.userId, userId));
}

/** Site-level capabilities the UI uses to show admin navigation. */
export async function siteCapabilities(tx: DB, req: FastifyRequest) {
  const system = await getSystemContext(tx, req.org.id);
  return capabilityMap(
    tx,
    req,
    [
      "site:config",
      "site:view_audit_log",
      "storage:manage",
      "payment:manage",
      "billing:manage",
      "user:view",
      "user:manage",
      "role:manage",
      "cohort:manage",
      "category:manage",
      "course:create",
      "certificate:manage_templates",
      "badge:manage",
      "report:view_site",
      "calendar:manage_site",
      "site:manage_sso",
      "site:view_system",
      "lti:manage_tools",
      "message:send",
      "message:send_any",
      "course:restore",
    ],
    system.id,
  );
}
