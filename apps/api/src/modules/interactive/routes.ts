import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { interactiveResults, users } from "@lms/db";
import { z } from "zod";
import { requireUser } from "../../core/auth";
import { badRequest, forbidden, notFound } from "../../core/errors";
import { emit, type EventMap } from "../../core/events";
import { zDate, zId, zNullableDate, zUserSummary } from "../../core/schemas";
import { storageFor } from "../../core/storage";
import { loadActivity } from "../activities/service";
import { isEnrolled } from "../courses/service";
import { pushGrade } from "../gradebook/service";
import { mimeOf, safeRequestPath } from "./h5p";
import { PACKAGE_CSP, PLAYER_CSP, playerHtml } from "./player";
import { bestRatio, h5pInfo, interactiveOf, packageToken, verifyPackageToken } from "./service";

const activityParam = z.object({ activityId: zId });

const zAttempt = z.object({
  id: zId,
  rawScore: z.number().nullable(),
  maxScore: z.number().nullable(),
  completed: z.boolean(),
  createdAt: zDate,
});

export const routes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/:activityId/launch",
    {
      schema: {
        tags: ["Interactive"],
        summary: "Get the player URL for an H5P activity (short-lived signed URL)",
        params: activityParam,
        response: { 200: z.object({ playerUrl: z.string(), expiresInSeconds: z.number() }) },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        requireUser(req);
        const { activity } = await loadActivity(tx, req, req.params.activityId, { type: "interactive", capability: "interactive:view" });
        const row = await interactiveOf(tx, activity.id);
        const h5p = row && row.kind === "h5p" ? h5pInfo(row) : null;
        if (!h5p) throw notFound("H5P package");
        const token = packageToken(activity.id, h5p.prefix);
        return { playerUrl: `/api/v1/interactive/${activity.id}/player/${token}`, expiresInSeconds: 6 * 3600 };
      }),
  );

  // Sandboxed player page and package files: authorised by the signed token (no cookies inside the sandbox).
  app.get(
    "/:activityId/player/:token",
    {
      schema: { tags: ["Interactive"], summary: "H5P player page (sandboxed, token-authorised)", params: activityParam.extend({ token: z.string().max(200) }) },
    },
    async (req, reply) => {
      const row = await req.tenant(async (tx) => {
        const r = await interactiveOf(tx, req.params.activityId);
        const h5p = r ? h5pInfo(r) : null;
        if (!r || !h5p || !verifyPackageToken(req.params.activityId, h5p.prefix, req.params.token)) throw notFound("Player");
        return { title: h5p.title };
      });
      return reply
        .header("Content-Security-Policy", PLAYER_CSP)
        .header("Cache-Control", "private, no-store")
        .header("X-Frame-Options", "SAMEORIGIN")
        .header("Cross-Origin-Resource-Policy", "same-origin")
        .type("text/html; charset=utf-8")
        .send(playerHtml({ title: row.title, packageBase: `/api/v1/interactive/${req.params.activityId}/h5p/${req.params.token}` }));
    },
  );

  app.get(
    "/:activityId/h5p/:token/*",
    {
      config: { rateLimit: { max: 3000, timeWindow: "1 minute" } },
      schema: {
        tags: ["Interactive"],
        summary: "Extracted H5P package file (token-authorised, sandboxed)",
        params: activityParam.extend({ token: z.string().max(200), "*": z.string().max(600) }),
      },
    },
    async (req, reply) => {
      const path = safeRequestPath(req.params["*"]);
      if (!path) throw notFound("File");
      const body = await req.tenant(async (tx) => {
        const r = await interactiveOf(tx, req.params.activityId);
        const h5p = r ? h5pInfo(r) : null;
        if (!r || !h5p || !verifyPackageToken(req.params.activityId, h5p.prefix, req.params.token)) throw notFound("File");
        const driver = await storageFor(tx, req.org.id);
        try {
          return await driver.get(`${h5p.prefix}/${path}`);
        } catch {
          throw notFound("File");
        }
      });
      return reply
        .header("Content-Security-Policy", PACKAGE_CSP)
        .header("Cache-Control", "private, max-age=3600")
        .header("X-Content-Type-Options", "nosniff")
        // Requested from the sandboxed (opaque-origin) player: needs CORS + cross-origin CORP.
        .header("Access-Control-Allow-Origin", "*")
        .header("Cross-Origin-Resource-Policy", "cross-origin")
        .type(mimeOf(path))
        .send(body);
    },
  );

  app.post(
    "/:activityId/result",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["Interactive"],
        summary: "Record a learner's result (xAPI-like). Keeps the best score in the gradebook.",
        params: activityParam,
        body: z.object({
          rawScore: z.number().min(0).max(1_000_000).nullable().optional(),
          maxScore: z.number().positive().max(1_000_000).nullable().optional(),
          completed: z.boolean().default(false),
          statement: z.record(z.unknown()).optional(),
        }),
        response: { 201: z.object({ id: zId, bestPercent: z.number().nullable() }) },
      },
    },
    async (req, reply) => {
      const me = requireUser(req);
      const b = req.body;
      if ((b.rawScore == null) !== (b.maxScore == null)) throw badRequest("rawScore and maxScore must be sent together");
      const statement = b.statement && JSON.stringify(b.statement).length <= 20_000 ? b.statement : null;

      const out = await req.tenant(async (tx) => {
        const { activity, course } = await loadActivity(tx, req, req.params.activityId, { type: "interactive", capability: "interactive:view" });
        if (!(await isEnrolled(tx, course.id, me.id))) throw forbidden("Only enrolled learners can record results");
        const row = await interactiveOf(tx, activity.id);
        if (!row) throw notFound("Interactive content");

        const raw = b.rawScore == null || b.maxScore == null ? null : Math.min(b.rawScore, b.maxScore);
        const previousBest = await bestRatio(tx, row.id, me.id);
        const [inserted] = await tx
          .insert(interactiveResults)
          .values({
            organizationId: req.org.id,
            interactiveId: row.id,
            userId: me.id,
            rawScore: raw,
            maxScore: b.maxScore ?? null,
            completed: b.completed,
            statement,
          })
          .returning({ id: interactiveResults.id });

        let grade: EventMap["grade.updated"] | null = null;
        if (raw !== null && b.maxScore) {
          const ratio = raw / b.maxScore;
          if (previousBest === null || ratio > previousBest) {
            grade = await pushGrade(tx, {
              organizationId: req.org.id,
              activityId: activity.id,
              userId: me.id,
              rawGrade: ratio * row.gradeMax,
              source: "interactive",
            });
          }
        }
        const best = await bestRatio(tx, row.id, me.id);
        return { id: inserted!.id, best, grade, activity };
      });

      if (out.grade) await emit("grade.updated", out.grade);
      const base = { organizationId: req.org.id, activityId: out.activity.id, courseId: out.activity.courseId, userId: me.id };
      await emit("interactive.result", base);
      if (req.body.completed) await emit("activity.submitted", base);
      return reply.status(201).send({ id: out.id, bestPercent: out.best === null ? null : Math.round(out.best * 10_000) / 100 });
    },
  );

  app.get(
    "/:activityId/results/me",
    {
      schema: {
        tags: ["Interactive"],
        summary: "My attempts and best score",
        params: activityParam,
        response: { 200: z.object({ attempts: z.array(zAttempt), bestPercent: z.number().nullable(), gradeMax: z.number() }) },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const me = requireUser(req);
        const { activity } = await loadActivity(tx, req, req.params.activityId, { type: "interactive" });
        const row = await interactiveOf(tx, activity.id);
        if (!row) throw notFound("Interactive content");
        const attempts = await tx
          .select()
          .from(interactiveResults)
          .where(and(eq(interactiveResults.interactiveId, row.id), eq(interactiveResults.userId, me.id)))
          .orderBy(desc(interactiveResults.createdAt))
          .limit(50);
        const best = await bestRatio(tx, row.id, me.id);
        return { attempts, bestPercent: best === null ? null : Math.round(best * 10_000) / 100, gradeMax: row.gradeMax };
      }),
  );

  app.get(
    "/:activityId/results",
    {
      schema: {
        tags: ["Interactive"],
        summary: "Results per learner (interactive:view_results)",
        params: activityParam,
        response: {
          200: z.array(
            z.object({
              user: zUserSummary,
              attempts: z.number().int(),
              bestPercent: z.number().nullable(),
              completed: z.boolean(),
              lastAttemptAt: zNullableDate,
            }),
          ),
        },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const { activity } = await loadActivity(tx, req, req.params.activityId, { type: "interactive", capability: "interactive:view_results" });
        const row = await interactiveOf(tx, activity.id);
        if (!row) throw notFound("Interactive content");
        const results = await tx
          .select()
          .from(interactiveResults)
          .where(eq(interactiveResults.interactiveId, row.id))
          .orderBy(asc(interactiveResults.createdAt))
          .limit(20_000);
        const byUser = new Map<string, { attempts: number; best: number | null; completed: boolean; last: Date | null }>();
        for (const r of results) {
          const s = byUser.get(r.userId) ?? { attempts: 0, best: null, completed: false, last: null };
          s.attempts++;
          if (r.rawScore !== null && r.maxScore) {
            const ratio = Math.max(0, Math.min(1, r.rawScore / r.maxScore));
            if (s.best === null || ratio > s.best) s.best = ratio;
          }
          s.completed ||= r.completed;
          s.last = r.createdAt;
          byUser.set(r.userId, s);
        }
        if (!byUser.size) return [];
        const people = await tx
          .select({ id: users.id, firstName: users.firstName, lastName: users.lastName, email: users.email })
          .from(users)
          .where(inArray(users.id, [...byUser.keys()]));
        return people
          .map((u) => {
            const s = byUser.get(u.id)!;
            return {
              user: u,
              attempts: s.attempts,
              bestPercent: s.best === null ? null : Math.round(s.best * 10_000) / 100,
              completed: s.completed,
              lastAttemptAt: s.last,
            };
          })
          .sort((a, b) => a.user.lastName.localeCompare(b.user.lastName));
      }),
  );
};
