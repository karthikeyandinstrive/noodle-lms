import { and, eq, gt, isNull } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { sessions, systemDb, users, type DB } from "@lms/db";
import { config } from "../config";
import { randomToken, sha256 } from "./crypto";
import { forbidden, unauthorized } from "./errors";
import type { SessionUser } from "./types";

export const SESSION_COOKIE = config.isProd ? "__Host-lms_session" : "lms_session";

/** Refresh lastSeenAt (sliding idle timeout) at most this often. */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

const idleMs = () => config.SESSION_IDLE_MINUTES * 60 * 1000;
const absoluteMs = () => config.SESSION_ABSOLUTE_DAYS * 24 * 60 * 60 * 1000;

/**
 * Creates a new server-side session and returns the opaque token.
 * Only the token's SHA-256 is stored, so a database leak does not leak sessions.
 * Always called after a successful login → fresh id (prevents session fixation).
 */
export async function createSession(tx: DB, req: FastifyRequest, userId: string) {
  const token = randomToken(32);
  await tx.insert(sessions).values({
    id: sha256(token),
    organizationId: req.org.id,
    userId,
    expiresAt: new Date(Date.now() + absoluteMs()),
    ip: req.ip,
    userAgent: req.headers["user-agent"]?.slice(0, 500),
  });
  return token;
}

export function setSessionCookie(reply: FastifyReply, token: string) {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.isProd,
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(absoluteMs() / 1000),
  });
}

export function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

function readToken(req: FastifyRequest): { token: string; via: "cookie" | "bearer" } | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return { token: header.slice(7).trim(), via: "bearer" };
  const cookie = req.cookies[SESSION_COOKIE];
  return cookie ? { token: cookie, via: "cookie" } : null;
}

export const authPlugin = fp(async (app) => {
  app.decorateRequest("user", null);
  app.decorateRequest("sessionId", null);
  app.decorateRequest("authVia", null);

  app.addHook("onRequest", async (req) => {
    req.capabilityCache = new Map();
    if (!req.org) return;
    const found = readToken(req);
    if (!found) return;

    const id = sha256(found.token);
    const db = await systemDb();
    const now = new Date();
    const [row] = await db
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(
        and(
          eq(sessions.id, id),
          eq(sessions.organizationId, req.org.id),
          gt(sessions.expiresAt, now),
          eq(users.status, "active"),
          isNull(users.deletedAt),
        ),
      )
      .limit(1);
    if (!row) return;

    // Idle timeout.
    if (now.getTime() - row.session.lastSeenAt.getTime() > idleMs()) {
      await db.delete(sessions).where(eq(sessions.id, id));
      return;
    }
    if (now.getTime() - row.session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, id));
    }

    req.sessionId = id;
    req.authVia = found.via;
    req.user = {
      id: row.user.id,
      email: row.user.email,
      firstName: row.user.firstName,
      lastName: row.user.lastName,
      locale: row.user.locale,
      timezone: row.user.timezone,
    } satisfies SessionUser;
  });

  /**
   * CSRF defence for cookie-authenticated, state-changing requests: the Origin
   * (or Referer) must be one of our allowed origins. SameSite=Lax alone does
   * not cover same-site subdomains or custom domains.
   */
  app.addHook("preHandler", async (req) => {
    if (req.authVia !== "cookie") return;
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
    const origin = req.headers.origin ?? (req.headers.referer ? new URL(req.headers.referer).origin : undefined);
    const host = req.host;
    const sameHost = origin && new URL(origin).host === host;
    if (!origin || !(sameHost || config.allowedOrigins.includes(origin))) {
      throw forbidden("Cross-origin request blocked");
    }
  });
});

/** Returns the signed-in user or throws 401. */
export function requireUser(req: FastifyRequest): SessionUser {
  if (!req.user) throw unauthorized();
  return req.user;
}
