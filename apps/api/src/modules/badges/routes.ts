import { and, asc, count, desc, eq, ilike, inArray, isNull, or } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { activities, badgeIssues, badges, courses, enrolments, files, getSystemContext, users, type BadgeCriteria, type DB } from "@lms/db";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "../../config";
import { audit } from "../../core/audit";
import { requireUser } from "../../core/auth";
import { hmac } from "../../core/crypto";
import { badRequest, must, notFound } from "../../core/errors";
import { emit } from "../../core/events";
import { assertOwnFiles, downloadUrl } from "../../core/files";
import { hasCapability, requireCapability } from "../../core/rbac";
import { ok, zDate, zId, zNullableDate, zOk, zUserSummary } from "../../core/schemas";
import { loadCourse } from "../courses/service";
import { buildAssertion, describeCriteria } from "./criteria";
import { awardBadge, badgeStatus, type BadgeIssueRow, type BadgeRow } from "./service";

// ─── Schemas ────────────────────────────────────────────────────────────────

const zCriteria = z.discriminatedUnion("type", [
  z.object({ type: z.literal("manual") }),
  z.object({ type: z.literal("course_completion"), courseId: zId.optional() }),
  z.object({ type: z.literal("activities"), activityIds: z.array(zId).min(1).max(50) }),
]);

const zBadgeInput = z.object({
  courseId: zId.nullable().optional(),
  name: z.string().trim().min(1).max(255),
  description: z.string().trim().min(1).max(5000),
  imageFileId: zId.nullable().optional(),
  criteria: zCriteria,
  status: z.enum(["active", "inactive"]).default("active"),
  expiresAfterDays: z.number().int().min(1).max(36_500).nullable().optional(),
});

const zCriteriaOut = z.union([
  z.object({ type: z.literal("manual") }),
  z.object({ type: z.literal("course_completion"), courseId: zId }),
  z.object({ type: z.literal("activities"), activityIds: z.array(zId) }),
]);

const zBadge = z.object({
  id: zId,
  courseId: zId.nullable(),
  name: z.string(),
  description: z.string(),
  imageFileId: zId.nullable(),
  criteria: zCriteriaOut,
  criteriaText: z.string(),
  status: z.string(),
  expiresAfterDays: z.number().int().nullable(),
  createdAt: zDate,
});

const zIssueStatus = z.enum(["valid", "revoked", "expired"]);
const zIssue = z.object({ id: zId, uniqueHash: z.string(), issuedAt: zDate, expiresAt: zNullableDate, revokedAt: zNullableDate, status: zIssueStatus });
const toIssue = (i: BadgeIssueRow) => ({ ...i, status: badgeStatus(i) });

const zHash = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Context in which a badge is managed/awarded: the course, or the system for site badges. */
async function badgeContext(tx: DB, req: FastifyRequest, courseId: string | null) {
  if (!courseId) return (await getSystemContext(tx, req.org.id)).id;
  const course = must((await tx.select().from(courses).where(eq(courses.id, courseId)).limit(1))[0], "Course");
  return course.contextId;
}

async function loadBadge(tx: DB, req: FastifyRequest, id: string, cap: "badge:manage" | "badge:award") {
  const badge = must((await tx.select().from(badges).where(eq(badges.id, id)).limit(1))[0], "Badge");
  const ctx = await badgeContext(tx, req, badge.courseId);
  if (!(await hasCapability(tx, req, cap, ctx))) throw notFound("Badge");
  return { badge, contextId: ctx };
}

async function criteriaNames(tx: DB, list: BadgeRow[]) {
  const courseIds = [...new Set(list.flatMap((b) => (b.criteria.type === "course_completion" ? [b.criteria.courseId] : [])))];
  const activityIds = [...new Set(list.flatMap((b) => (b.criteria.type === "activities" ? b.criteria.activityIds : [])))];
  const [cs, as] = await Promise.all([
    courseIds.length ? tx.select({ id: courses.id, name: courses.fullname }).from(courses).where(inArray(courses.id, courseIds)) : Promise.resolve([]),
    activityIds.length ? tx.select({ id: activities.id, name: activities.name }).from(activities).where(inArray(activities.id, activityIds)) : Promise.resolve([]),
  ]);
  const names = new Map([...cs, ...as].map((r) => [r.id, r.name]));
  return (b: BadgeRow) =>
    describeCriteria(b.criteria, {
      course: b.criteria.type === "course_completion" ? names.get(b.criteria.courseId) : undefined,
      activities: b.criteria.type === "activities" ? b.criteria.activityIds.map((id) => names.get(id) ?? "(deleted activity)") : undefined,
    });
}

async function toBadges(tx: DB, list: BadgeRow[]) {
  const describe = await criteriaNames(tx, list);
  return list.map((b) => ({ ...b, criteriaText: describe(b) }));
}

/** Validates criteria against the badge scope and fills in the course for course badges. */
async function normalizeCriteria(tx: DB, courseId: string | null, c: z.infer<typeof zCriteria>): Promise<BadgeCriteria> {
  if (c.type === "manual") return c;
  if (c.type === "course_completion") {
    const target = courseId ?? c.courseId;
    if (!target) throw badRequest("Choose the course to complete");
    if (courseId && c.courseId && c.courseId !== courseId) throw badRequest("Course badges can only require completion of their own course");
    must((await tx.select({ id: courses.id }).from(courses).where(eq(courses.id, target)).limit(1))[0], "Course");
    return { type: "course_completion", courseId: target };
  }
  if (!courseId) throw badRequest("Activity criteria are only available for course badges");
  const ids = [...new Set(c.activityIds)];
  const found = await tx.select({ id: activities.id }).from(activities).where(and(eq(activities.courseId, courseId), inArray(activities.id, ids)));
  if (found.length !== ids.length) throw badRequest("All activities must belong to this course");
  return { type: "activities", activityIds: ids };
}

async function attachImage(tx: DB, req: FastifyRequest, badgeId: string, contextId: string, fileId: string, current: string | null) {
  if (fileId === current) return;
  await assertOwnFiles(tx, req, [fileId]);
  const f = must((await tx.select().from(files).where(eq(files.id, fileId)).limit(1))[0], "File");
  if (!/^image\/(png|jpeg|gif|webp|svg\+xml)$/.test(f.mimeType)) throw badRequest("The badge image must be an image");
  if (f.mimeType === "image/svg+xml") throw badRequest("Use a PNG or JPEG image for badges");
  await tx.update(files).set({ component: "badge", area: "image", itemId: badgeId, contextId }).where(eq(files.id, fileId));
}

const salt = (hash: string) => hmac(`badge-salt:${hash}`).slice(0, 16);

// ─── Routes ─────────────────────────────────────────────────────────────────

export const routes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/",
    {
      schema: {
        tags: ["Badges"],
        summary: "Manage list: site badges (no courseId) or a course's badges (badge:manage)",
        querystring: z.object({ courseId: zId.optional() }),
        response: { 200: z.array(zBadge.extend({ recipients: z.number().int() })) },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        requireUser(req);
        const courseId = req.query.courseId ?? null;
        await requireCapability(tx, req, "badge:manage", await badgeContext(tx, req, courseId));
        const list = await tx
          .select()
          .from(badges)
          .where(courseId ? eq(badges.courseId, courseId) : isNull(badges.courseId))
          .orderBy(asc(badges.name));
        const counts = list.length
          ? await tx
              .select({ badgeId: badgeIssues.badgeId, n: count() })
              .from(badgeIssues)
              .where(and(inArray(badgeIssues.badgeId, list.map((b) => b.id)), isNull(badgeIssues.revokedAt)))
              .groupBy(badgeIssues.badgeId)
          : [];
        const countOf = new Map(counts.map((c) => [c.badgeId, Number(c.n)]));
        return (await toBadges(tx, list)).map((b) => ({ ...b, recipients: countOf.get(b.id) ?? 0 }));
      }),
  );

  app.get(
    "/courses/:courseId",
    {
      schema: {
        tags: ["Badges"],
        summary: "Active badges of a course, with whether I earned them",
        params: z.object({ courseId: zId }),
        response: { 200: z.array(zBadge.extend({ earned: zIssue.nullable() })) },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const me = requireUser(req);
        const course = await loadCourse(tx, req, req.params.courseId);
        const list = await tx
          .select()
          .from(badges)
          .where(and(eq(badges.courseId, course.id), eq(badges.status, "active")))
          .orderBy(asc(badges.name));
        const mine = list.length
          ? await tx.select().from(badgeIssues).where(and(eq(badgeIssues.userId, me.id), inArray(badgeIssues.badgeId, list.map((b) => b.id))))
          : [];
        const byBadge = new Map(mine.map((i) => [i.badgeId, i]));
        return (await toBadges(tx, list)).map((b) => {
          const i = byBadge.get(b.id);
          return { ...b, earned: i ? toIssue(i) : null };
        });
      }),
  );

  app.post(
    "/",
    { schema: { tags: ["Badges"], summary: "Create a site or course badge (badge:manage)", body: zBadgeInput, response: { 201: zBadge } } },
    async (req, reply) => {
      const me = requireUser(req);
      const row = await req.tenant(async (tx) => {
        const courseId = req.body.courseId ?? null;
        const ctx = await badgeContext(tx, req, courseId);
        await requireCapability(tx, req, "badge:manage", ctx);
        const id = crypto.randomUUID();
        const criteria = await normalizeCriteria(tx, courseId, req.body.criteria);
        if (req.body.imageFileId) await attachImage(tx, req, id, ctx, req.body.imageFileId, null);
        const [b] = await tx
          .insert(badges)
          .values({
            id,
            organizationId: req.org.id,
            courseId,
            name: req.body.name,
            description: req.body.description,
            imageFileId: req.body.imageFileId ?? null,
            criteria,
            status: req.body.status,
            expiresAfterDays: req.body.expiresAfterDays ?? null,
            createdBy: me.id,
          })
          .returning();
        await audit(tx, req, "badge.created", { type: "badge", id }, { courseId });
        return (await toBadges(tx, [b!]))[0]!;
      });
      return reply.status(201).send(row);
    },
  );

  app.get(
    "/me",
    {
      schema: {
        tags: ["Badges"],
        summary: "Badges I earned",
        response: { 200: z.array(zIssue.extend({ badge: zBadge.pick({ id: true, name: true, description: true, imageFileId: true, courseId: true }), courseName: z.string().nullable() })) },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const me = requireUser(req);
        const rows = await tx
          .select({ issue: badgeIssues, badge: badges, courseName: courses.fullname })
          .from(badgeIssues)
          .innerJoin(badges, eq(badges.id, badgeIssues.badgeId))
          .leftJoin(courses, eq(courses.id, badges.courseId))
          .where(eq(badgeIssues.userId, me.id))
          .orderBy(desc(badgeIssues.issuedAt));
        return rows.map((r) => ({ ...toIssue(r.issue), badge: r.badge, courseName: r.courseName }));
      }),
  );

  // ─── Public Open Badges endpoints (anonymous, rate limited) ────────────

  const publicCfg = { rateLimit: { max: 60, timeWindow: "1 minute" } };

  app.get(
    "/assertions/:hash",
    {
      config: publicCfg,
      schema: {
        tags: ["Badges"],
        summary: "Open Badges 2.0 hosted Assertion (public)",
        params: z.object({ hash: zHash }),
        response: { 200: z.record(z.unknown()), 410: z.record(z.unknown()) },
      },
    },
    async (req, reply) => {
      const out = await req.tenant(async (tx) => {
        const [row] = await tx
          .select({ issue: badgeIssues, badge: badges, email: users.email })
          .from(badgeIssues)
          .innerJoin(badges, eq(badges.id, badgeIssues.badgeId))
          .innerJoin(users, eq(users.id, badgeIssues.userId))
          .where(eq(badgeIssues.uniqueHash, req.params.hash))
          .limit(1);
        if (!row) throw notFound("Assertion");
        const describe = await criteriaNames(tx, [row.badge]);
        return { ...row, narrative: describe(row.badge) };
      });
      reply.header("Cache-Control", "no-store").header("Access-Control-Allow-Origin", "*").header("Cross-Origin-Resource-Policy", "cross-origin");
      const id = `${config.APP_URL.replace(/\/+$/, "")}/api/v1/badges/assertions/${out.issue.uniqueHash}`;
      if (out.issue.revokedAt) {
        return reply.status(410).send({ "@context": "https://w3id.org/openbadges/v2", type: "Assertion", id, revoked: true, revocationReason: "Revoked by the issuer" });
      }
      return buildAssertion({
        baseUrl: config.APP_URL,
        uniqueHash: out.issue.uniqueHash,
        salt: salt(out.issue.uniqueHash),
        recipientEmail: out.email,
        issuedOn: out.issue.issuedAt,
        expires: out.issue.expiresAt,
        badge: { id: out.badge.id, name: out.badge.name, description: out.badge.description, criteriaNarrative: out.narrative, hasImage: !!out.badge.imageFileId },
        issuer: { name: req.org.name, url: config.APP_URL },
      });
    },
  );

  app.get(
    "/assertions/:hash/summary",
    {
      config: publicCfg,
      schema: {
        tags: ["Badges"],
        summary: "Human-readable badge verification (public page data)",
        params: z.object({ hash: zHash }),
        response: {
          200: z.object({
            badgeId: zId,
            badgeName: z.string(),
            description: z.string(),
            criteria: z.string(),
            hasImage: z.boolean(),
            recipientName: z.string(),
            courseName: z.string().nullable(),
            issuerName: z.string(),
            issuedAt: zDate,
            expiresAt: zNullableDate,
            status: zIssueStatus,
          }),
        },
      },
    },
    async (req, reply) => {
      reply.header("Cache-Control", "no-store");
      return req.tenant(async (tx) => {
        const [row] = await tx
          .select({ issue: badgeIssues, badge: badges, firstName: users.firstName, lastName: users.lastName, courseName: courses.fullname })
          .from(badgeIssues)
          .innerJoin(badges, eq(badges.id, badgeIssues.badgeId))
          .innerJoin(users, eq(users.id, badgeIssues.userId))
          .leftJoin(courses, eq(courses.id, badges.courseId))
          .where(eq(badgeIssues.uniqueHash, req.params.hash))
          .limit(1);
        if (!row) throw notFound("Badge");
        const describe = await criteriaNames(tx, [row.badge]);
        return {
          badgeId: row.badge.id,
          badgeName: row.badge.name,
          description: row.badge.description,
          criteria: describe(row.badge),
          hasImage: !!row.badge.imageFileId,
          recipientName: `${row.firstName} ${row.lastName}`.trim(),
          courseName: row.courseName,
          issuerName: req.org.name,
          issuedAt: row.issue.issuedAt,
          expiresAt: row.issue.expiresAt,
          status: badgeStatus(row.issue),
        };
      });
    },
  );

  app.get(
    "/classes/:id",
    { config: publicCfg, schema: { tags: ["Badges"], summary: "Open Badges 2.0 BadgeClass (public)", params: z.object({ id: zId }), response: { 200: z.record(z.unknown()) } } },
    async (req, reply) => {
      const { badge, narrative } = await req.tenant(async (tx) => {
        const b = must((await tx.select().from(badges).where(eq(badges.id, req.params.id)).limit(1))[0], "Badge");
        return { badge: b, narrative: (await criteriaNames(tx, [b]))(b) };
      });
      const base = config.APP_URL.replace(/\/+$/, "");
      reply.header("Access-Control-Allow-Origin", "*").header("Cross-Origin-Resource-Policy", "cross-origin");
      return {
        "@context": "https://w3id.org/openbadges/v2",
        type: "BadgeClass",
        id: `${base}/api/v1/badges/classes/${badge.id}`,
        name: badge.name,
        description: badge.description,
        ...(badge.imageFileId ? { image: `${base}/api/v1/badges/classes/${badge.id}/image` } : {}),
        criteria: { narrative },
        issuer: `${base}/api/v1/badges/issuer`,
      };
    },
  );

  app.get(
    "/classes/:id/image",
    { config: publicCfg, schema: { tags: ["Badges"], summary: "Badge image (public redirect to a signed URL)", params: z.object({ id: zId }) } },
    async (req, reply) => {
      const url = await req.tenant(async (tx) => {
        const b = must((await tx.select().from(badges).where(eq(badges.id, req.params.id)).limit(1))[0], "Badge");
        if (!b.imageFileId) throw notFound("Image");
        const f = must((await tx.select().from(files).where(eq(files.id, b.imageFileId)).limit(1))[0], "Image");
        if (f.component !== "badge" || f.deletedAt || f.status !== "ready") throw notFound("Image");
        return downloadUrl(tx, req, f, true);
      });
      reply.header("Cache-Control", "public, max-age=240").header("Cross-Origin-Resource-Policy", "cross-origin");
      return reply.redirect(url, 302);
    },
  );

  app.get(
    "/issuer",
    { config: publicCfg, schema: { tags: ["Badges"], summary: "Open Badges 2.0 issuer Profile (public)", response: { 200: z.record(z.unknown()) } } },
    async (req, reply) => {
      const base = config.APP_URL.replace(/\/+$/, "");
      reply.header("Access-Control-Allow-Origin", "*").header("Cross-Origin-Resource-Policy", "cross-origin");
      return { "@context": "https://w3id.org/openbadges/v2", type: "Profile", id: `${base}/api/v1/badges/issuer`, name: req.org.name, url: base };
    },
  );

  // ─── Single badge management ───────────────────────────────────────────

  app.get(
    "/:id",
    { schema: { tags: ["Badges"], summary: "Get a badge (badge:manage)", params: z.object({ id: zId }), response: { 200: zBadge } } },
    (req) =>
      req.tenant(async (tx) => {
        requireUser(req);
        const { badge } = await loadBadge(tx, req, req.params.id, "badge:manage");
        return (await toBadges(tx, [badge]))[0]!;
      }),
  );

  app.patch(
    "/:id",
    {
      schema: {
        tags: ["Badges"],
        summary: "Update a badge (badge:manage)",
        params: z.object({ id: zId }),
        body: zBadgeInput.omit({ courseId: true }).partial(),
        response: { 200: zBadge },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        requireUser(req);
        const { badge, contextId } = await loadBadge(tx, req, req.params.id, "badge:manage");
        const b = req.body;
        const patch: Partial<typeof badges.$inferInsert> = {};
        if (b.name !== undefined) patch.name = b.name;
        if (b.description !== undefined) patch.description = b.description;
        if (b.status !== undefined) patch.status = b.status;
        if (b.expiresAfterDays !== undefined) patch.expiresAfterDays = b.expiresAfterDays;
        if (b.criteria !== undefined) patch.criteria = await normalizeCriteria(tx, badge.courseId, b.criteria);
        if (b.imageFileId !== undefined) {
          if (b.imageFileId) await attachImage(tx, req, badge.id, contextId, b.imageFileId, badge.imageFileId);
          patch.imageFileId = b.imageFileId;
        }
        const [row] = Object.keys(patch).length ? await tx.update(badges).set(patch).where(eq(badges.id, badge.id)).returning() : [badge];
        await audit(tx, req, "badge.updated", { type: "badge", id: badge.id }, { fields: Object.keys(patch) });
        return (await toBadges(tx, [row!]))[0]!;
      }),
  );

  app.delete(
    "/:id",
    { schema: { tags: ["Badges"], summary: "Delete a badge and its awards (badge:manage)", params: z.object({ id: zId }), response: { 200: zOk } } },
    async (req) => {
      await req.tenant(async (tx) => {
        requireUser(req);
        const { badge } = await loadBadge(tx, req, req.params.id, "badge:manage");
        await tx.delete(badges).where(eq(badges.id, badge.id));
        await audit(tx, req, "badge.deleted", { type: "badge", id: badge.id }, { name: badge.name });
      });
      return ok;
    },
  );

  app.get(
    "/:id/recipients",
    {
      schema: {
        tags: ["Badges"],
        summary: "Who earned this badge (badge:award)",
        params: z.object({ id: zId }),
        response: { 200: z.array(zIssue.extend({ user: zUserSummary, issuedBy: zId.nullable() })) },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        requireUser(req);
        const { badge } = await loadBadge(tx, req, req.params.id, "badge:award");
        const rows = await tx
          .select({ issue: badgeIssues, user: { id: users.id, firstName: users.firstName, lastName: users.lastName, email: users.email } })
          .from(badgeIssues)
          .innerJoin(users, eq(users.id, badgeIssues.userId))
          .where(eq(badgeIssues.badgeId, badge.id))
          .orderBy(desc(badgeIssues.issuedAt));
        return rows.map((r) => ({ ...toIssue(r.issue), user: r.user }));
      }),
  );

  app.get(
    "/:id/candidates",
    {
      schema: {
        tags: ["Badges"],
        summary: "Users who can be awarded this badge (course: enrolled learners; site: search users) (badge:award)",
        params: z.object({ id: zId }),
        querystring: z.object({ search: z.string().trim().max(100).optional() }),
        response: { 200: z.array(zUserSummary.extend({ awarded: z.boolean() })) },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        requireUser(req);
        const { badge } = await loadBadge(tx, req, req.params.id, "badge:award");
        const q = req.query.search;
        const match = q ? or(ilike(users.firstName, `%${q}%`), ilike(users.lastName, `%${q}%`), ilike(users.email, `%${q}%`)) : undefined;
        const cols = { id: users.id, firstName: users.firstName, lastName: users.lastName, email: users.email };
        const people = badge.courseId
          ? await tx
              .select(cols)
              .from(enrolments)
              .innerJoin(users, eq(users.id, enrolments.userId))
              .where(and(eq(enrolments.courseId, badge.courseId), eq(enrolments.status, "active"), match))
              .orderBy(asc(users.lastName))
              .limit(200)
          : q
            ? await tx
                .select(cols)
                .from(users)
                .where(and(isNull(users.deletedAt), eq(users.status, "active"), match))
                .orderBy(asc(users.lastName))
                .limit(25)
            : [];
        const issued = people.length
          ? await tx
              .select({ userId: badgeIssues.userId })
              .from(badgeIssues)
              .where(and(eq(badgeIssues.badgeId, badge.id), isNull(badgeIssues.revokedAt), inArray(badgeIssues.userId, people.map((p) => p.id))))
          : [];
        const has = new Set(issued.map((i) => i.userId));
        return people.map((p) => ({ ...p, awarded: has.has(p.id) }));
      }),
  );

  app.post(
    "/:id/award",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["Badges"],
        summary: "Award a badge manually (badge:award)",
        params: z.object({ id: zId }),
        body: z.object({ userIds: z.array(zId).min(1).max(200) }),
        response: { 200: z.object({ awarded: z.number().int() }) },
      },
    },
    async (req) => {
      const me = requireUser(req);
      const out = await req.tenant(async (tx) => {
        const { badge } = await loadBadge(tx, req, req.params.id, "badge:award");
        if (badge.status !== "active") throw badRequest("This badge is not active");
        const ids = [...new Set(req.body.userIds)];
        let allowed: string[];
        if (badge.courseId) {
          allowed = (
            await tx
              .select({ id: enrolments.userId })
              .from(enrolments)
              .where(and(eq(enrolments.courseId, badge.courseId), eq(enrolments.status, "active"), inArray(enrolments.userId, ids)))
          ).map((r) => r.id);
        } else {
          allowed = (await tx.select({ id: users.id }).from(users).where(and(inArray(users.id, ids), isNull(users.deletedAt)))).map((r) => r.id);
        }
        if (allowed.length !== ids.length) throw badRequest(badge.courseId ? "All recipients must be enrolled in the course" : "Unknown user");
        const awarded: string[] = [];
        for (const userId of ids) {
          const issue = await awardBadge(tx, { badge, userId, issuedBy: me.id, reinstate: true });
          if (issue) awarded.push(userId);
        }
        if (awarded.length) await audit(tx, req, "badge.awarded", { type: "badge", id: badge.id }, { userIds: awarded });
        return { badge, awarded };
      });
      for (const userId of out.awarded) {
        await emit("badge.awarded", { organizationId: req.org.id, userId, badgeId: out.badge.id, courseId: out.badge.courseId });
      }
      return { awarded: out.awarded.length };
    },
  );

  app.post(
    "/issues/:issueId/revoke",
    {
      schema: {
        tags: ["Badges"],
        summary: "Revoke an awarded badge (badge:award)",
        params: z.object({ issueId: zId }),
        body: z.object({ reason: z.string().trim().max(500).optional() }).default({}),
        response: { 200: zIssue },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        requireUser(req);
        const issue = must((await tx.select().from(badgeIssues).where(eq(badgeIssues.id, req.params.issueId)).limit(1))[0], "Badge award");
        await loadBadge(tx, req, issue.badgeId, "badge:award");
        if (issue.revokedAt) return toIssue(issue);
        const [row] = await tx.update(badgeIssues).set({ revokedAt: new Date() }).where(eq(badgeIssues.id, issue.id)).returning();
        await audit(tx, req, "badge.revoked", { type: "badge_issue", id: issue.id }, { badgeId: issue.badgeId, userId: issue.userId, reason: req.body.reason ?? null });
        return toIssue(row!);
      }),
  );
};
