import type { FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { AppError } from "../../core/errors";
import type { LmsModule } from "../../core/types";
import { mfaEnrollmentRequired } from "../mfa/service";
import { routes } from "./routes";

/** Routes a user who must enroll in MFA can still reach. */
const ENROLLMENT_ALLOWED = new Set(["/api/v1/auth/me", "/api/v1/auth/logout", "/api/v1/auth/logout-all"]);
const ENROLLMENT_ALLOWED_PREFIX = "/api/v1/auth/mfa/";

/**
 * MFA enrollment gate (organization policy `settings.requireMfaForAdmins`).
 *
 * Approach: sessions carry no "restricted" flag (the schema has none). Instead, for
 * every authenticated request while the policy is on, we re-check — in the request's
 * tenant transaction — whether the user is an org_admin/manager at the system context
 * without enabled MFA. If so, only /auth/me, /auth/mfa/* and logout are reachable.
 * This is stateless and always current: enrolling unlocks the session immediately,
 * turning the policy on restricts existing sessions too, and bearer tokens are covered.
 * The cost (one indexed query) is only paid by signed-in users while the policy is on.
 */
export async function mfaEnrollmentGate(req: FastifyRequest) {
  const user = req.user;
  if (!user || req.org?.settings?.requireMfaForAdmins !== true) return;
  const url = req.routeOptions.url ?? "";
  if (ENROLLMENT_ALLOWED.has(url) || url.startsWith(ENROLLMENT_ALLOWED_PREFIX)) return;
  if (await req.tenant((tx) => mfaEnrollmentRequired(tx, req.org, user.id))) {
    throw new AppError(403, "MFA_ENROLLMENT_REQUIRED", "Your organization requires administrators to set up two-factor authentication.");
  }
}

/**
 * The auth module is wrapped with fastify-plugin so that its preHandler applies to
 * every module registered after it under /api/v1 (auth is first in modules/index.ts).
 * fastify-plugin ignores the register prefix, so the routes are mounted at /auth here.
 */
const plugin: FastifyPluginAsyncZod = async (app) => {
  app.addHook("preHandler", mfaEnrollmentGate);
  await app.register(routes, { prefix: "/auth" });
};

export const authModule: LmsModule = {
  name: "auth",
  basePath: "/",
  routes: fp(plugin, { name: "lms-auth-module" }) as unknown as FastifyPluginAsyncZod,
};
