import { verify } from "@node-rs/argon2";
import { eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { ARGON2_OPTIONS, userMfa, users, type DB } from "@lms/db";
import QRCode from "qrcode";
import { z } from "zod";
import { requireUser, setSessionCookie } from "../../core/auth";
import { audit } from "../../core/audit";
import { decryptSecret, encryptSecret } from "../../core/crypto";
import { AppError, badRequest, conflict, unauthorized } from "../../core/errors";
import { ok, zId, zNullableDate, zOk } from "../../core/schemas";
import { accountLocked, completeLogin, DeferredError, isLocked, recordFailedLogin, throwIfDeferred } from "../auth/service";
import {
  consumeMfaChallenge,
  findMfaChallenge,
  getEnabledMfa,
  getMfa,
  mfaEnrollmentRequired,
  notifySecurity,
  useSecondFactor,
} from "./service";
import { generateRecoveryCodes, generateTotpSecret, hashRecoveryCode, otpauthUri, verifyTotp } from "./totp";

const zCode = z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code");
const zRecoveryCode = z.string().trim().min(8).max(20);
const zReauth = z
  .object({ password: z.string().min(1).max(200).optional(), code: zCode.optional() })
  .refine((v) => !!v.password !== !!v.code, "Provide your password or a current code");

const zMe = z.object({ id: zId, email: z.string(), firstName: z.string(), lastName: z.string(), locale: z.string(), timezone: z.string() });

const mfaLimit = { rateLimit: { max: 10, timeWindow: "1 minute" } };

export const routes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/status",
    {
      schema: {
        tags: ["MFA"],
        summary: "Two-factor authentication status of the current user",
        response: {
          200: z.object({
            enabled: z.boolean(),
            pending: z.boolean().describe("Setup started but not confirmed"),
            enabledAt: zNullableDate,
            recoveryCodesRemaining: z.number().int(),
            required: z.boolean().describe("The organization requires this user to enroll"),
          }),
        },
      },
    },
    async (req) => {
      const me = requireUser(req);
      return req.tenant(async (tx) => {
        const row = await getMfa(tx, me.id);
        return {
          enabled: !!row?.enabledAt,
          pending: !!row && !row.enabledAt,
          enabledAt: row?.enabledAt ?? null,
          recoveryCodesRemaining: row?.enabledAt ? row.recoveryCodeHashes.length : 0,
          required: await mfaEnrollmentRequired(tx, req.org, me.id),
        };
      });
    },
  );

  app.post(
    "/setup",
    {
      config: mfaLimit,
      schema: {
        tags: ["MFA"],
        summary: "Start TOTP enrollment: returns the otpauth URI and a QR code (secret stored unconfirmed)",
        response: { 200: z.object({ secret: z.string(), otpauthUri: z.string(), qrCodeDataUrl: z.string() }) },
      },
    },
    async (req) => {
      const me = requireUser(req);
      const secret = generateTotpSecret();
      await req.tenant(async (tx) => {
        const existing = await getMfa(tx, me.id);
        if (existing?.enabledAt) throw conflict("Two-factor authentication is already enabled. Disable it first to change your authenticator.");
        const values = { totpSecretEnc: encryptSecret(secret), enabledAt: null, recoveryCodeHashes: [], lastUsedStep: null };
        if (existing) await tx.update(userMfa).set(values).where(eq(userMfa.id, existing.id));
        else await tx.insert(userMfa).values({ ...values, organizationId: req.org.id, userId: me.id });
        await audit(tx, req, "mfa.setup_started", { type: "user", id: me.id });
      });
      const uri = otpauthUri({ secret, issuer: req.org.name, account: me.email });
      return { secret, otpauthUri: uri, qrCodeDataUrl: await QRCode.toDataURL(uri, { margin: 1, width: 240 }) };
    },
  );

  app.post(
    "/enable",
    {
      config: mfaLimit,
      schema: {
        tags: ["MFA"],
        summary: "Confirm enrollment with a first code; returns 10 one-time recovery codes (shown once)",
        body: z.object({ code: zCode }),
        response: { 200: z.object({ recoveryCodes: z.array(z.string()) }) },
      },
    },
    async (req) => {
      const me = requireUser(req);
      return req.tenant(async (tx) => {
        const row = await getMfa(tx, me.id);
        if (!row) throw badRequest("Start the setup first");
        if (row.enabledAt) throw conflict("Two-factor authentication is already enabled");
        const step = verifyTotp(decryptSecret(row.totpSecretEnc), req.body.code);
        if (step === null) throw badRequest("That code is not valid. Check your device's clock and try again.");
        const recoveryCodes = generateRecoveryCodes(10);
        await tx
          .update(userMfa)
          .set({ enabledAt: new Date(), lastUsedStep: String(step), recoveryCodeHashes: recoveryCodes.map(hashRecoveryCode) })
          .where(eq(userMfa.id, row.id));
        await audit(tx, req, "mfa.enabled", { type: "user", id: me.id });
        await notifySecurity(tx, req.org.id, me.id, "Two-factor authentication enabled", "Two-factor authentication was turned on for your account. If this wasn't you, contact your administrator.");
        return { recoveryCodes };
      });
    },
  );

  /** Re-authenticates the current user with their password or a TOTP / recovery code. */
  async function reauth(tx: DB, userId: string, body: { password?: string | undefined; code?: string | undefined }) {
    const mfa = await getEnabledMfa(tx, userId);
    if (!mfa) throw badRequest("Two-factor authentication is not enabled");
    if (body.password) {
      const [user] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
      const valid = user?.passwordHash && (await verify(user.passwordHash, body.password, ARGON2_OPTIONS).catch(() => false));
      if (!valid) throw badRequest("Password is incorrect");
    } else if (!(await useSecondFactor(tx, mfa, { code: body.code })).ok) {
      throw badRequest("That code is not valid");
    }
    return mfa;
  }

  app.post(
    "/disable",
    { config: mfaLimit, schema: { tags: ["MFA"], summary: "Turn off two-factor authentication (password or current code)", body: zReauth, response: { 200: zOk } } },
    async (request) => {
      const me = requireUser(request);
      await request.tenant(async (tx) => {
        const mfa = await reauth(tx, me.id, request.body);
        await tx.delete(userMfa).where(eq(userMfa.id, mfa.id));
        await audit(tx, request, "mfa.disabled", { type: "user", id: me.id }, { method: request.body.password ? "password" : "code" });
        await notifySecurity(tx, request.org.id, me.id, "Two-factor authentication disabled", "Two-factor authentication was turned off for your account. If this wasn't you, change your password and contact your administrator.");
      });
      return ok;
    },
  );

  app.post(
    "/recovery-codes/regenerate",
    {
      config: mfaLimit,
      schema: {
        tags: ["MFA"],
        summary: "Replace all recovery codes (password or current code); returns the new codes once",
        body: zReauth,
        response: { 200: z.object({ recoveryCodes: z.array(z.string()) }) },
      },
    },
    async (request) => {
      const me = requireUser(request);
      return request.tenant(async (tx) => {
        const mfa = await reauth(tx, me.id, request.body);
        const recoveryCodes = generateRecoveryCodes(10);
        await tx.update(userMfa).set({ recoveryCodeHashes: recoveryCodes.map(hashRecoveryCode) }).where(eq(userMfa.id, mfa.id));
        await audit(tx, request, "mfa.recovery_codes_regenerated", { type: "user", id: me.id });
        await notifySecurity(tx, request.org.id, me.id, "New recovery codes generated", "Your previous two-factor recovery codes no longer work.");
        return { recoveryCodes };
      });
    },
  );

  app.post(
    "/verify",
    {
      config: mfaLimit,
      schema: {
        tags: ["MFA"],
        summary: "Second sign-in step: exchange an MFA challenge + code for a session (cookie, or bearer token with ?mode=token)",
        querystring: z.object({ mode: z.enum(["cookie", "token"]).default("cookie") }),
        body: z
          .object({ challengeToken: z.string().min(20).max(200), code: zCode.optional(), recoveryCode: zRecoveryCode.optional() })
          .refine((v) => !!v.code !== !!v.recoveryCode, "Provide a code or a recovery code"),
        response: { 200: z.union([z.object({ token: z.string(), user: zMe }), z.object({ user: zMe })]) },
      },
    },
    async (request, reply) => {
      const result = throwIfDeferred(
        await request.tenant(async (tx) => {
          const challenge = await findMfaChallenge(tx, request.body.challengeToken);
          if (!challenge) throw new AppError(401, "MFA_CHALLENGE_INVALID", "Your sign-in attempt expired. Sign in again.");
          const [user] = await tx.select().from(users).where(eq(users.id, challenge.userId)).limit(1);
          if (!user || user.deletedAt) throw new AppError(401, "MFA_CHALLENGE_INVALID", "Your sign-in attempt expired. Sign in again.");
          if (isLocked(user)) throw accountLocked();
          if (user.status !== "active") throw new AppError(403, "ACCOUNT_SUSPENDED", "This account is not active");
          const mfa = await getEnabledMfa(tx, user.id);
          if (!mfa) throw new AppError(401, "MFA_CHALLENGE_INVALID", "Your sign-in attempt expired. Sign in again.");

          const factor = await useSecondFactor(tx, mfa, { code: request.body.code, recoveryCode: request.body.recoveryCode });
          if (!factor.ok) {
            // Shares the password failure counter → the account locks after repeated failures.
            await recordFailedLogin(tx, user);
            return new DeferredError(unauthorized("That code is not valid"));
          }
          if (!(await consumeMfaChallenge(tx, challenge.id))) throw new AppError(401, "MFA_CHALLENGE_INVALID", "Your sign-in attempt expired. Sign in again.");
          const token = await completeLogin(tx, request, user.id);
          if (factor.method === "recovery") {
            await audit(tx, request, "mfa.recovery_code_used", { type: "user", id: user.id }, { remaining: factor.remainingRecoveryCodes });
            await notifySecurity(
              tx,
              request.org.id,
              user.id,
              "A recovery code was used to sign in",
              `${factor.remainingRecoveryCodes} recovery codes remain. If this wasn't you, change your password now.`,
            );
          }
          return { user, token };
        }),
      );
      if (request.query.mode === "token") return { token: result.token, user: result.user };
      setSessionCookie(reply, result.token);
      return { user: result.user };
    },
  );
};
