import { and, eq, gt, inArray, isNotNull, isNull } from "drizzle-orm";
import { authTokens, getSystemContext, roleAssignments, roles, userMfa, type DB } from "@lms/db";
import { decryptSecret, randomToken, sha256 } from "../../core/crypto";
import { notify } from "../../core/notify";
import type { Org } from "../../core/types";
import { hashRecoveryCode, verifyTotp } from "./totp";

export const MFA_CHALLENGE_TTL_MINUTES = 5;
/** Roles that the organization policy `requireMfaForAdmins` applies to (at the system context). */
export const MFA_POLICY_ARCHETYPES = ["org_admin", "manager"];

export async function getMfa(tx: DB, userId: string) {
  const [row] = await tx.select().from(userMfa).where(eq(userMfa.userId, userId)).limit(1);
  return row ?? null;
}

export async function getEnabledMfa(tx: DB, userId: string) {
  const [row] = await tx
    .select()
    .from(userMfa)
    .where(and(eq(userMfa.userId, userId), isNotNull(userMfa.enabledAt)))
    .limit(1);
  return row ?? null;
}

/** True when the user holds one of the role archetypes at the organization's system context. */
export async function hasSystemRole(tx: DB, organizationId: string, userId: string, archetypes: string[]) {
  const system = await getSystemContext(tx, organizationId);
  const [row] = await tx
    .select({ id: roleAssignments.id })
    .from(roleAssignments)
    .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
    .where(and(eq(roleAssignments.userId, userId), eq(roleAssignments.contextId, system.id), inArray(roles.archetype, archetypes)))
    .limit(1);
  return !!row;
}

/**
 * The organization requires MFA for administrators and this user is one
 * (org_admin / manager at the system context) without MFA enabled.
 */
export async function mfaEnrollmentRequired(tx: DB, org: Pick<Org, "id" | "settings">, userId: string) {
  if (org.settings?.requireMfaForAdmins !== true) return false;
  if (!(await hasSystemRole(tx, org.id, userId, MFA_POLICY_ARCHETYPES))) return false;
  return !(await getEnabledMfa(tx, userId));
}

/** Single-use, 5-minute token proving the password step succeeded. Only its hash is stored. */
export async function issueMfaChallenge(tx: DB, organizationId: string, userId: string) {
  const token = randomToken(32);
  await tx.insert(authTokens).values({
    organizationId,
    userId,
    purpose: "mfa_challenge",
    tokenHash: sha256(token),
    expiresAt: new Date(Date.now() + MFA_CHALLENGE_TTL_MINUTES * 60_000),
  });
  return token;
}

export async function findMfaChallenge(tx: DB, token: string) {
  const [row] = await tx
    .select()
    .from(authTokens)
    .where(
      and(eq(authTokens.tokenHash, sha256(token)), eq(authTokens.purpose, "mfa_challenge"), isNull(authTokens.usedAt), gt(authTokens.expiresAt, new Date())),
    )
    .limit(1);
  return row ?? null;
}

/** Marks the challenge used; false if another request consumed it first. */
export async function consumeMfaChallenge(tx: DB, id: string) {
  const rows = await tx
    .update(authTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(authTokens.id, id), isNull(authTokens.usedAt)))
    .returning({ id: authTokens.id });
  return rows.length === 1;
}

type MfaRow = typeof userMfa.$inferSelect;

/**
 * Checks a TOTP code or a recovery code against an MFA row and, on success,
 * persists the replay marker / removes the used recovery code.
 */
export async function useSecondFactor(
  tx: DB,
  mfa: MfaRow,
  input: { code?: string | undefined; recoveryCode?: string | undefined },
): Promise<{ ok: false } | { ok: true; method: "totp" | "recovery"; remainingRecoveryCodes: number }> {
  if (input.code) {
    const lastUsedStep = mfa.lastUsedStep != null ? Number(mfa.lastUsedStep) : null;
    const step = verifyTotp(decryptSecret(mfa.totpSecretEnc), input.code, { lastUsedStep });
    if (step === null) return { ok: false };
    // Conditional update: two concurrent requests with the same code cannot both win.
    const updated = await tx
      .update(userMfa)
      .set({ lastUsedStep: String(step) })
      .where(and(eq(userMfa.id, mfa.id), mfa.lastUsedStep == null ? isNull(userMfa.lastUsedStep) : eq(userMfa.lastUsedStep, mfa.lastUsedStep)))
      .returning({ id: userMfa.id });
    if (!updated.length) return { ok: false };
    return { ok: true, method: "totp", remainingRecoveryCodes: mfa.recoveryCodeHashes.length };
  }
  if (input.recoveryCode) {
    const hash = hashRecoveryCode(input.recoveryCode);
    if (!mfa.recoveryCodeHashes.includes(hash)) return { ok: false };
    const remaining = mfa.recoveryCodeHashes.filter((h) => h !== hash);
    await tx.update(userMfa).set({ recoveryCodeHashes: remaining }).where(eq(userMfa.id, mfa.id));
    return { ok: true, method: "recovery", remainingRecoveryCodes: remaining.length };
  }
  return { ok: false };
}

export async function notifySecurity(tx: DB, organizationId: string, userId: string, title: string, body?: string) {
  await notify(tx, { organizationId, userIds: [userId], type: "security", title, body, link: "/profile" });
}
