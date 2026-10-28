import { and, asc, eq, inArray } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { scormAttempts, users } from "@lms/db";
import { z } from "zod";
import { requireUser } from "../../core/auth";
import { conflict, forbidden, must, notFound } from "../../core/errors";
import { emitInTx } from "../../core/events";
import { hasCapability } from "../../core/rbac";
import { zDate, zId, zUserSummary } from "../../core/schemas";
import { storageFor } from "../../core/storage";
import { loadActivity } from "../activities/service";
import { pushGrade } from "../gradebook/service";
import { safeEntryPath } from "../interactive/zip";
import {
  computeScore,
  computeStatus,
  exitKey,
  FINISHED,
  mergeCmi,
  ratioOf,
  validateCmi,
  type Cmi,
  type NormalizedStatus,
} from "./cmi";
import { entryFor, foldSessionTime, initialCmi, type SessionMode } from "./runtime";
import { aggregateRatio, attemptsOf, contentToken, manifestOf, packageOf, packageRules, verifyContentToken, type AttemptRow } from "./service";

const activityParam = z.object({ activityId: zId });

/**
 * Package content is served same-origin with the player page (required by the SCORM API
 * discovery: the SCO calls `window.parent.API`). Residual risk, accepted like Moodle does:
 * package JavaScript uploaded by a teacher (activity:create holders only) runs in the LMS
 * origin and could act with the learner's session. Mitigations: short-lived per-user
 * tokens, strict CSP (no third-party scripts, frames limited to self, no plugins), nosniff,
 * explicit content types, no directory listing, and only teachers can upload packages.
 */
export const CONTENT_CSP = [
  "default-src 'self'",
  // SCORM content relies heavily on inline scripts/handlers and sometimes eval.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "frame-ancestors 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const MIME: Record<string, string> = {
  html: "text/html",
  htm: "text/html",
  xhtml: "application/xhtml+xml",
  js: "text/javascript",
  mjs: "text/javascript",
  css: "text/css",
  json: "application/json",
  xml: "application/xml",
  xsd: "application/xml",
  dtd: "application/xml-dtd",
  txt: "text/plain",
  vtt: "text/vtt",
  srt: "text/plain",
  csv: "text/csv",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  ogv: "video/ogg",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
  pdf: "application/pdf",
  swf: "application/x-shockwave-flash",
  wasm: "application/wasm",
};

export function scormMime(path: string) {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return MIME[ext] ?? "application/octet-stream";
}

/** Package-relative path requested by the browser, protected against traversal. */
export function contentPath(raw: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const safe = safeEntryPath(decoded);
  if (!safe || safe.split("/").some((p) => p.startsWith(".") && p !== ".well-known")) return null;
  return safe;
}

const zAttempt = z.object({
  id: zId,
  attempt: z.number().int(),
  status: z.string(),
  scoreRaw: z.number().nullable(),
  scoreMax: z.number().nullable(),
  scorePercent: z.number().nullable(),
  totalTimeSeconds: z.number().int(),
  startedAt: zDate,
  updatedAt: zDate,
});

const percent = (ratio: number | null) => (ratio === null ? null : Math.round(ratio * 10_000) / 100);
const attemptOut = (a: AttemptRow) => ({
  id: a.id,
  attempt: a.attempt,
  status: a.status,
  scoreRaw: a.scoreRaw,
  scoreMax: a.scoreMax,
  scorePercent: percent(ratioOf(a)),
  totalTimeSeconds: a.totalTimeSeconds,
  startedAt: a.startedAt,
  updatedAt: a.updatedAt,
});

const canStartNew = (maxAttempts: number, attempts: AttemptRow[]) => {
  const last = attempts[attempts.length - 1];
  if (!last) return true;
  return FINISHED.includes(last.status as NormalizedStatus) && (maxAttempts === 0 || attempts.length < maxAttempts);
};

export const routes: FastifyPluginAsyncZod = async (app) => {
  // ─── Package content (same-origin, token-authorised) ────────────────────

  app.get(
    "/:activityId/content/:token/*",
    {
      config: { rateLimit: { max: 3000, timeWindow: "1 minute" } },
      schema: {
        tags: ["SCORM"],
        summary: "Extracted SCORM package file (signed per-user token, same-origin with the player)",
        params: activityParam.extend({ token: z.string().max(300), "*": z.string().max(1000) }),
      },
    },
    async (req, reply) => {
      const path = contentPath(req.params["*"]);
      if (!path) throw notFound("File");
      const body = await req.tenant(async (tx) => {
        const pkg = await packageOf(tx, req.params.activityId);
        const ok = pkg ? verifyContentToken(req.params.token, req.params.activityId, pkg.storagePrefix) : null;
        // The token is bound to a user; when a session is present it must be that user.
        if (!pkg || !ok || (req.user && req.user.id !== ok.userId)) throw notFound("File");
        const driver = await storageFor(tx, req.org.id);
        try {
          return await driver.get(`${pkg.storagePrefix}/${path}`);
        } catch {
          throw notFound("File");
        }
      });
      return reply
        .header("Content-Security-Policy", CONTENT_CSP)
        .header("X-Content-Type-Options", "nosniff")
        .header("X-Frame-Options", "SAMEORIGIN")
        .header("Cross-Origin-Resource-Policy", "same-origin")
        .header("Referrer-Policy", "same-origin")
        .header("Cache-Control", "private, max-age=3600")
        .type(scormMime(path))
        .send(body);
    },
  );

  // ─── Attempts ───────────────────────────────────────────────────────────

  app.post(
    "/:activityId/attempts",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["SCORM"],
        summary: "Start or resume an attempt; returns the initial CMI data model and the content URL",
        params: activityParam,
        body: z.object({ newAttempt: z.boolean().default(false) }).default({ newAttempt: false }),
        response: {
          200: z.object({
            attemptId: zId.nullable(),
            attempt: z.number().int().nullable(),
            version: z.enum(["1.2", "2004"]),
            mode: z.enum(["normal", "browse", "review"]),
            contentUrl: z.string(),
            cmi: z.record(z.string(), z.string()),
            multiSco: z.boolean(),
          }),
        },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const me = requireUser(req);
        const { activity } = await loadActivity(tx, req, req.params.activityId, { type: "scorm" });
        const pkg = await packageOf(tx, activity.id);
        if (!pkg) throw notFound("SCORM package");
        const canAttempt = await hasCapability(tx, req, "scorm:attempt", activity.contextId);
        const canPreview = await hasCapability(tx, req, "activity:update", activity.contextId);
        if (!canAttempt && !canPreview) throw forbidden("Missing capability scorm:attempt");

        const manifest = manifestOf(pkg);
        const entry = pkg.entryHref;
        const contentUrl = `/api/v1/scorm/${activity.id}/content/${contentToken(me.id, activity.id, pkg.storagePrefix)}/${entry
          .split("/")
          .map((seg, i, all) => (i === all.length - 1 ? seg.replace(/[^?#]+/, (p) => encodeURIComponent(p)) : encodeURIComponent(seg)))
          .join("/")}`;
        const base = { version: pkg.version, contentUrl, multiSco: manifest.multiSco ?? false };

        // Editors without scorm:attempt preview in browse mode: nothing is recorded.
        if (!canAttempt) {
          return {
            ...base,
            attemptId: null,
            attempt: null,
            mode: "browse" as const,
            cmi: initialCmi({ version: pkg.version, stored: {}, totalSeconds: 0, entry: "ab-initio", mode: "browse", user: me, manifest }),
          };
        }

        const attempts = await attemptsOf(tx, pkg.id, me.id);
        let current = attempts[attempts.length - 1];
        if (!current || (req.body.newAttempt && FINISHED.includes(current.status as NormalizedStatus))) {
          if (current && pkg.maxAttempts > 0 && attempts.length >= pkg.maxAttempts) throw conflict("You have used all your attempts");
          const [created] = await tx
            .insert(scormAttempts)
            .values({ organizationId: req.org.id, packageId: pkg.id, userId: me.id, attempt: (current?.attempt ?? 0) + 1 })
            .returning();
          current = created!;
        }

        const fresh = Object.keys(current.cmi).length === 0 && current.totalTimeSeconds === 0;
        const entryValue = entryFor(pkg.version, current.cmi, fresh);
        // A new session: fold any session_time left by a session that never finished, clear exit.
        const folded = foldSessionTime(pkg.version, current.cmi, current.totalTimeSeconds);
        const { [exitKey(pkg.version)]: _exit, ...cmi } = folded.cmi;
        if (folded.totalSeconds !== current.totalTimeSeconds || _exit !== undefined) {
          await tx.update(scormAttempts).set({ cmi, totalTimeSeconds: folded.totalSeconds, updatedAt: new Date() }).where(eq(scormAttempts.id, current.id));
        }
        const mode: SessionMode = "normal";
        return {
          ...base,
          attemptId: current.id,
          attempt: current.attempt,
          mode,
          cmi: initialCmi({ version: pkg.version, stored: cmi, totalSeconds: folded.totalSeconds, entry: entryValue, mode, user: me, manifest }),
        };
      }),
  );

  app.put(
    "/:activityId/attempts/:attemptId/commit",
    {
      config: { rateLimit: { max: 240, timeWindow: "1 minute" } },
      schema: {
        tags: ["SCORM"],
        summary: "Commit CMI values written by the SCO (owner only). `finish` ends the session.",
        params: activityParam.extend({ attemptId: zId }),
        body: z.object({
          cmi: z.record(z.string(), z.string().max(70_000)).refine((m) => Object.keys(m).length <= 3000, "Too many elements"),
          finish: z.boolean().default(false),
        }),
        response: {
          200: z.object({
            status: z.string(),
            scoreRaw: z.number().nullable(),
            scoreMax: z.number().nullable(),
            totalTimeSeconds: z.number().int(),
            rejected: z.array(z.object({ key: z.string(), reason: z.string() })),
          }),
        },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const me = requireUser(req);
        const { activity } = await loadActivity(tx, req, req.params.activityId, { type: "scorm", capability: "scorm:attempt" });
        const pkg = must(await packageOf(tx, activity.id), "SCORM package");
        const [attempt] = await tx
          .select()
          .from(scormAttempts)
          .where(and(eq(scormAttempts.id, req.params.attemptId), eq(scormAttempts.packageId, pkg.id)))
          .limit(1);
        // IDOR: only the owner may write; other users' attempts look missing.
        if (!attempt || attempt.userId !== me.id) throw notFound("Attempt");
        const attempts = await attemptsOf(tx, pkg.id, me.id);
        if (attempts[attempts.length - 1]?.id !== attempt.id) throw conflict("Only your latest attempt can be updated");

        // Whitelist + validate; invalid elements are dropped (and reported) so valid progress is never lost.
        const problems = validateCmi(pkg.version, req.body.cmi);
        const bad = new Set(problems.map((p) => p.key));
        const accepted: Cmi = Object.fromEntries(Object.entries(req.body.cmi).filter(([k]) => !bad.has(k)));
        let cmi = mergeCmi(pkg.version, attempt.cmi, accepted);
        let totalSeconds = attempt.totalTimeSeconds;
        if (req.body.finish) ({ cmi, totalSeconds } = foldSessionTime(pkg.version, cmi, totalSeconds));

        const status = computeStatus(pkg.version, cmi, packageRules(pkg));
        const score = computeScore(pkg.version, cmi);
        const [saved] = await tx
          .update(scormAttempts)
          .set({ cmi, status, scoreRaw: score?.raw ?? null, scoreMax: score?.max ?? null, totalTimeSeconds: totalSeconds, updatedAt: new Date() })
          .where(eq(scormAttempts.id, attempt.id))
          .returning();

        const base = { organizationId: req.org.id, activityId: activity.id, courseId: activity.courseId, userId: me.id };
        const scoreChanged = (score?.raw ?? null) !== attempt.scoreRaw || (score?.max ?? null) !== attempt.scoreMax;
        if (scoreChanged) {
          const ratio = aggregateRatio(pkg, attempts.map((a) => (a.id === saved!.id ? saved! : a)));
          if (ratio !== null) {
            const grade = await pushGrade(tx, { organizationId: req.org.id, activityId: activity.id, userId: me.id, rawGrade: ratio * pkg.gradeMax, source: "scorm" });
            if (grade) await emitInTx(tx, "grade.updated", grade);
          }
        }
        if (status !== attempt.status || scoreChanged || req.body.finish) await emitInTx(tx, "scorm.committed", { ...base, status });
        const done = (s: string) => s === "completed" || s === "passed";
        if (done(status) && !done(attempt.status)) await emitInTx(tx, "activity.submitted", base);

        return { status, scoreRaw: saved!.scoreRaw, scoreMax: saved!.scoreMax, totalTimeSeconds: totalSeconds, rejected: problems };
      }),
  );

  app.get(
    "/:activityId/attempts/me",
    {
      schema: {
        tags: ["SCORM"],
        summary: "My attempts and aggregated grade",
        params: activityParam,
        response: {
          200: z.object({
            attempts: z.array(zAttempt),
            gradePercent: z.number().nullable(),
            gradeMethod: z.string(),
            maxAttempts: z.number().int(),
            canStartNew: z.boolean(),
            canAttempt: z.boolean(),
          }),
        },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const me = requireUser(req);
        const { activity } = await loadActivity(tx, req, req.params.activityId, { type: "scorm" });
        const pkg = must(await packageOf(tx, activity.id), "SCORM package");
        const attempts = await attemptsOf(tx, pkg.id, me.id);
        return {
          attempts: attempts.map(attemptOut).reverse(),
          gradePercent: percent(aggregateRatio(pkg, attempts)),
          gradeMethod: pkg.gradeMethod,
          maxAttempts: pkg.maxAttempts,
          canStartNew: attempts.length > 0 && canStartNew(pkg.maxAttempts, attempts),
          canAttempt: await hasCapability(tx, req, "scorm:attempt", activity.contextId),
        };
      }),
  );

  app.get(
    "/:activityId/report",
    {
      schema: {
        tags: ["SCORM"],
        summary: "Attempts of all learners (scorm:view_reports)",
        params: activityParam,
        response: {
          200: z.array(
            z.object({
              user: zUserSummary,
              attempts: z.number().int(),
              status: z.string(),
              gradePercent: z.number().nullable(),
              totalTimeSeconds: z.number().int(),
              lastAccessAt: zDate,
              history: z.array(zAttempt),
            }),
          ),
        },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const { activity } = await loadActivity(tx, req, req.params.activityId, { type: "scorm", capability: "scorm:view_reports" });
        const pkg = must(await packageOf(tx, activity.id), "SCORM package");
        const rows = await tx.select().from(scormAttempts).where(eq(scormAttempts.packageId, pkg.id)).orderBy(asc(scormAttempts.attempt)).limit(20_000);
        const byUser = new Map<string, AttemptRow[]>();
        for (const r of rows) byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), r]);
        if (!byUser.size) return [];
        const people = await tx
          .select({ id: users.id, firstName: users.firstName, lastName: users.lastName, email: users.email })
          .from(users)
          .where(inArray(users.id, [...byUser.keys()]));
        return people
          .map((u) => {
            const list = byUser.get(u.id)!;
            const last = list[list.length - 1]!;
            return {
              user: u,
              attempts: list.length,
              status: last.status,
              gradePercent: percent(aggregateRatio(pkg, list)),
              totalTimeSeconds: list.reduce((s, a) => s + a.totalTimeSeconds, 0),
              lastAccessAt: list.reduce((d, a) => (a.updatedAt > d ? a.updatedAt : d), last.updatedAt),
              history: list.map(attemptOut).reverse(),
            };
          })
          .sort((a, b) => a.user.lastName.localeCompare(b.user.lastName));
      }),
  );
};

