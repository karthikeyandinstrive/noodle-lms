import { and, asc, count, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import {
  activityCompletions,
  assignmentSubmissions,
  cohortMembers,
  cohorts,
  courses,
  enrolments,
  forumPosts,
  getSystemContext,
  gradeGrades,
  hashPassword,
  roleAssignments,
  roles,
  sessions,
  users,
  type DB,
} from "@lms/db";
import { z } from "zod";
import { requireUser } from "../../core/auth";
import { audit } from "../../core/audit";
import { config } from "../../config";
import { badRequest, must } from "../../core/errors";
import { emit } from "../../core/events";
import { enqueue } from "../../core/jobs";
import { sendMail } from "../../core/mail";
import { requireCapability } from "../../core/rbac";
import { offset, ok, paged, zDate, zId, zNullableDate, zOk, zPagination } from "../../core/schemas";
import { consumeAuthToken, issueAuthToken, zPassword } from "../auth/service";
import { enrolUser, loadCourseWith } from "../courses/service";

const zUser = z.object({
  id: zId,
  email: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  bio: z.string().nullable(),
  avatarFileId: zId.nullable(),
  locale: z.string(),
  timezone: z.string(),
  status: z.enum(["active", "suspended", "pending"]),
  emailVerifiedAt: zNullableDate,
  lastLoginAt: zNullableDate,
  createdAt: zDate,
});

const zUserInput = z.object({
  email: z.string().email().max(320),
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  locale: z.string().max(10).default("en"),
  timezone: z.string().max(64).default("UTC"),
});

const zProfileInput = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  bio: z.string().max(5000).nullable(),
  avatarFileId: zId.nullable(),
  locale: z.string().max(10),
  timezone: z.string().max(64),
});

const zCohort = z.object({ id: zId, name: z.string(), idnumber: z.string().nullable(), description: z.string().nullable(), memberCount: z.number().int() });

async function systemCap(tx: DB, req: Parameters<typeof requireCapability>[1] & { org: { id: string } }, cap: "user:view" | "user:manage" | "cohort:manage") {
  const system = await getSystemContext(tx, req.org.id);
  await requireCapability(tx, req, cap, system.id);
}

async function inviteUser(tx: DB, organizationId: string, orgName: string, user: typeof users.$inferSelect) {
  const token = await issueAuthToken(tx, { organizationId, userId: user.id, purpose: "invite", ttlMinutes: 60 * 24 * 7 });
  enqueue("invite-email", () =>
    sendMail({
      to: user.email,
      subject: `You're invited to ${orgName}`,
      text: `Set your password to get started: ${config.APP_URL}/accept-invite?token=${token}`,
    }),
  );
}

export const routes: FastifyPluginAsyncZod = async (app) => {
  // ─── Own profile ────────────────────────────────────────────────────────

  app.get("/users/me", { schema: { tags: ["Users"], summary: "My profile", response: { 200: zUser } } }, (req) => {
    const me = requireUser(req);
    return req.tenant(async (tx) => must((await tx.select().from(users).where(eq(users.id, me.id)).limit(1))[0]));
  });

  app.patch(
    "/users/me",
    { schema: { tags: ["Users"], summary: "Update my profile", body: zProfileInput.partial(), response: { 200: zUser } } },
    (req) => {
      const me = requireUser(req);
      return req.tenant(async (tx) => (await tx.update(users).set(req.body).where(eq(users.id, me.id)).returning())[0]!);
    },
  );

  app.get(
    "/users/me/export",
    { schema: { tags: ["Users"], summary: "Download my personal data (GDPR Art. 15/20)", response: { 200: z.record(z.unknown()) } } },
    (req) => {
      const me = requireUser(req);
      return req.tenant(async (tx) => {
        const [profile] = await tx.select().from(users).where(eq(users.id, me.id));
        const { passwordHash: _p, ...safeProfile } = profile!;
        return {
          exportedAt: new Date().toISOString(),
          profile: safeProfile,
          enrolments: await tx.select({ course: courses.fullname, status: enrolments.status, since: enrolments.createdAt }).from(enrolments).innerJoin(courses, eq(courses.id, enrolments.courseId)).where(eq(enrolments.userId, me.id)),
          grades: await tx.select().from(gradeGrades).where(eq(gradeGrades.userId, me.id)),
          completions: await tx.select().from(activityCompletions).where(eq(activityCompletions.userId, me.id)),
          submissions: await tx.select().from(assignmentSubmissions).where(eq(assignmentSubmissions.userId, me.id)),
          forumPosts: await tx.select().from(forumPosts).where(eq(forumPosts.userId, me.id)),
        };
      });
    },
  );

  // ─── Administration ─────────────────────────────────────────────────────

  app.get(
    "/users",
    {
      schema: {
        tags: ["Users"],
        summary: "List users",
        querystring: zPagination.extend({ search: z.string().max(100).optional(), status: z.enum(["active", "suspended", "pending"]).optional() }),
        response: { 200: paged(zUser) },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        await systemCap(tx, req, "user:view");
        const q = req.query;
        const where = and(
          isNull(users.deletedAt),
          q.status ? eq(users.status, q.status) : undefined,
          q.search ? or(ilike(users.email, `%${q.search}%`), ilike(users.firstName, `%${q.search}%`), ilike(users.lastName, `%${q.search}%`)) : undefined,
        );
        const [items, [{ total }]] = (await Promise.all([
          tx.select().from(users).where(where).orderBy(asc(users.lastName), asc(users.firstName)).limit(q.pageSize).offset(offset(q)),
          tx.select({ total: count() }).from(users).where(where),
        ])) as [(typeof users.$inferSelect)[], [{ total: number }]];
        return { items, total, page: q.page, pageSize: q.pageSize };
      }),
  );

  app.post(
    "/users",
    {
      schema: {
        tags: ["Users"],
        summary: "Create a user (with a password, or send an invitation email)",
        body: zUserInput.extend({ password: zPassword.optional(), sendInvite: z.boolean().default(true) }),
        response: { 201: zUser },
      },
    },
    async (req, reply) => {
      const user = await req.tenant(async (tx) => {
        await systemCap(tx, req, "user:manage");
        const { password, sendInvite, ...input } = req.body;
        const [created] = await tx
          .insert(users)
          .values({
            ...input,
            email: input.email.toLowerCase(),
            organizationId: req.org.id,
            passwordHash: password ? await hashPassword(password) : null,
            status: password ? "active" : "pending",
          })
          .returning();
        if (!password && sendInvite) await inviteUser(tx, req.org.id, req.org.name, created!);
        await audit(tx, req, "user.created", { type: "user", id: created!.id });
        return created!;
      });
      await emit("user.created", { organizationId: req.org.id, userId: user.id });
      return reply.status(201).send(user);
    },
  );

  app.post(
    "/users/import",
    {
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: {
        tags: ["Users"],
        summary: "Bulk-create users from CSV rows (email,firstName,lastName). Invitations are emailed.",
        body: z.object({ rows: z.array(zUserInput.pick({ email: true, firstName: true, lastName: true })).min(1).max(1000) }),
        response: { 200: z.object({ created: z.number().int(), skipped: z.array(z.string()) }) },
      },
    },
    async (req) => {
      const result = await req.tenant(async (tx) => {
        await systemCap(tx, req, "user:manage");
        const emails = req.body.rows.map((r) => r.email.toLowerCase());
        const existing = new Set(
          (await tx.select({ email: users.email }).from(users).where(inArray(sql`lower(${users.email})`, emails))).map((r) => r.email.toLowerCase()),
        );
        const toCreate = req.body.rows.filter((r) => !existing.has(r.email.toLowerCase()));
        const created = toCreate.length
          ? await tx.insert(users).values(toCreate.map((r) => ({ ...r, email: r.email.toLowerCase(), organizationId: req.org.id, status: "pending" as const }))).returning()
          : [];
        for (const u of created) await inviteUser(tx, req.org.id, req.org.name, u);
        await audit(tx, req, "user.imported", undefined, { created: created.length });
        return { created, skipped: [...existing] };
      });
      for (const u of result.created) await emit("user.created", { organizationId: req.org.id, userId: u.id });
      return { created: result.created.length, skipped: result.skipped };
    },
  );

  app.get(
    "/users/:id",
    {
      schema: {
        tags: ["Users"],
        summary: "User details with site roles and enrolments",
        params: z.object({ id: zId }),
        response: {
          200: zUser.extend({
            siteRoles: z.array(z.string()),
            courses: z.array(z.object({ id: zId, fullname: z.string(), status: z.string() })),
          }),
        },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        await systemCap(tx, req, "user:view");
        const user = must((await tx.select().from(users).where(and(eq(users.id, req.params.id), isNull(users.deletedAt))).limit(1))[0], "User");
        const system = await getSystemContext(tx, req.org.id);
        const siteRoles = await tx
          .select({ shortname: roles.shortname })
          .from(roleAssignments)
          .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
          .where(and(eq(roleAssignments.userId, user.id), eq(roleAssignments.contextId, system.id)));
        const userCourses = await tx
          .select({ id: courses.id, fullname: courses.fullname, status: enrolments.status })
          .from(enrolments)
          .innerJoin(courses, eq(courses.id, enrolments.courseId))
          .where(eq(enrolments.userId, user.id));
        return { ...user, siteRoles: siteRoles.map((r) => r.shortname), courses: userCourses };
      }),
  );

  app.patch(
    "/users/:id",
    {
      schema: {
        tags: ["Users"],
        summary: "Update a user (suspending signs them out everywhere)",
        params: z.object({ id: zId }),
        body: zUserInput.partial().extend({ status: z.enum(["active", "suspended"]).optional(), password: zPassword.optional() }),
        response: { 200: zUser },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        await systemCap(tx, req, "user:manage");
        if (req.params.id === req.user?.id && req.body.status === "suspended") throw badRequest("You cannot suspend yourself");
        const { password, ...rest } = req.body;
        const patch: Partial<typeof users.$inferInsert> = { ...rest, ...(rest.email ? { email: rest.email.toLowerCase() } : {}) };
        if (password) patch.passwordHash = await hashPassword(password);
        const [user] = await tx.update(users).set(patch).where(and(eq(users.id, req.params.id), isNull(users.deletedAt))).returning();
        must(user, "User");
        if (req.body.status === "suspended" || password) await tx.delete(sessions).where(eq(sessions.userId, user!.id));
        await audit(tx, req, "user.updated", { type: "user", id: user!.id }, { fields: Object.keys(rest), passwordReset: !!password });
        return user!;
      }),
  );

  app.delete(
    "/users/:id",
    {
      schema: {
        tags: ["Users"],
        summary: "Delete a user: personal data is anonymized, learning records are kept (GDPR erasure)",
        params: z.object({ id: zId }),
        response: { 200: zOk },
      },
    },
    async (req) => {
      await req.tenant(async (tx) => {
        await systemCap(tx, req, "user:manage");
        if (req.params.id === req.user?.id) throw badRequest("You cannot delete yourself");
        const [user] = await tx
          .update(users)
          .set({
            email: `deleted-${req.params.id}@invalid`,
            firstName: "Deleted",
            lastName: "user",
            bio: null,
            avatarFileId: null,
            passwordHash: null,
            status: "suspended",
            deletedAt: new Date(),
          })
          .where(and(eq(users.id, req.params.id), isNull(users.deletedAt)))
          .returning();
        must(user, "User");
        await tx.delete(sessions).where(eq(sessions.userId, req.params.id));
        await tx.delete(roleAssignments).where(eq(roleAssignments.userId, req.params.id));
        await audit(tx, req, "user.deleted", { type: "user", id: req.params.id });
      });
      return ok;
    },
  );

  // ─── Accept invitation ──────────────────────────────────────────────────

  app.post(
    "/users/accept-invite",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: { tags: ["Users"], summary: "Set password from an invitation link", body: z.object({ token: z.string().min(10), password: zPassword }), response: { 200: zOk } },
    },
    async (req) => {
      await req.tenant(async (tx) => {
        const row = await consumeAuthToken(tx, req.body.token, "invite");
        await tx
          .update(users)
          .set({ passwordHash: await hashPassword(req.body.password), status: "active", emailVerifiedAt: new Date() })
          .where(eq(users.id, row.userId));
      });
      return ok;
    },
  );

  // ─── Cohorts ────────────────────────────────────────────────────────────

  async function listCohorts(tx: DB) {
    const rows = await tx
      .select({ c: cohorts, n: count(cohortMembers.id) })
      .from(cohorts)
      .leftJoin(cohortMembers, eq(cohortMembers.cohortId, cohorts.id))
      .groupBy(cohorts.id)
      .orderBy(asc(cohorts.name));
    return rows.map(({ c, n }) => ({ id: c.id, name: c.name, idnumber: c.idnumber, description: c.description, memberCount: Number(n) }));
  }

  app.get("/cohorts", { schema: { tags: ["Cohorts"], summary: "List cohorts", response: { 200: z.array(zCohort) } } }, (req) =>
    req.tenant(async (tx) => {
      await systemCap(tx, req, "cohort:manage");
      return listCohorts(tx);
    }),
  );

  const zCohortInput = z.object({ name: z.string().trim().min(1).max(255), idnumber: z.string().max(100).nullable().optional(), description: z.string().max(5000).nullable().optional() });

  app.post("/cohorts", { schema: { tags: ["Cohorts"], summary: "Create a cohort", body: zCohortInput, response: { 201: zCohort } } }, async (req, reply) => {
    const row = await req.tenant(async (tx) => {
      await systemCap(tx, req, "cohort:manage");
      const [c] = await tx.insert(cohorts).values({ ...req.body, organizationId: req.org.id }).returning();
      return { ...c!, memberCount: 0 };
    });
    return reply.status(201).send(row);
  });

  app.patch(
    "/cohorts/:id",
    { schema: { tags: ["Cohorts"], summary: "Update a cohort", params: z.object({ id: zId }), body: zCohortInput.partial(), response: { 200: zOk } } },
    async (req) => {
      await req.tenant(async (tx) => {
        await systemCap(tx, req, "cohort:manage");
        must((await tx.update(cohorts).set(req.body).where(eq(cohorts.id, req.params.id)).returning())[0], "Cohort");
      });
      return ok;
    },
  );

  app.delete("/cohorts/:id", { schema: { tags: ["Cohorts"], summary: "Delete a cohort", params: z.object({ id: zId }), response: { 200: zOk } } }, async (req) => {
    await req.tenant(async (tx) => {
      await systemCap(tx, req, "cohort:manage");
      await tx.delete(cohorts).where(eq(cohorts.id, req.params.id));
    });
    return ok;
  });

  app.get(
    "/cohorts/:id/members",
    { schema: { tags: ["Cohorts"], summary: "Cohort members", params: z.object({ id: zId }), response: { 200: z.array(z.object({ id: zId, firstName: z.string(), lastName: z.string(), email: z.string() })) } } },
    (req) =>
      req.tenant(async (tx) => {
        await systemCap(tx, req, "cohort:manage");
        return tx
          .select({ id: users.id, firstName: users.firstName, lastName: users.lastName, email: users.email })
          .from(cohortMembers)
          .innerJoin(users, eq(users.id, cohortMembers.userId))
          .where(eq(cohortMembers.cohortId, req.params.id));
      }),
  );

  app.put(
    "/cohorts/:id/members",
    { schema: { tags: ["Cohorts"], summary: "Add or remove cohort members", params: z.object({ id: zId }), body: z.object({ add: z.array(zId).default([]), remove: z.array(zId).default([]) }), response: { 200: zOk } } },
    async (req) => {
      await req.tenant(async (tx) => {
        await systemCap(tx, req, "cohort:manage");
        must((await tx.select().from(cohorts).where(eq(cohorts.id, req.params.id)).limit(1))[0], "Cohort");
        if (req.body.add.length) {
          await tx
            .insert(cohortMembers)
            .values(req.body.add.map((userId) => ({ organizationId: req.org.id, cohortId: req.params.id, userId })))
            .onConflictDoNothing();
        }
        if (req.body.remove.length) {
          await tx.delete(cohortMembers).where(and(eq(cohortMembers.cohortId, req.params.id), inArray(cohortMembers.userId, req.body.remove)));
        }
      });
      return ok;
    },
  );

  app.post(
    "/courses/:courseId/cohort-enrol",
    {
      schema: {
        tags: ["Enrolment"],
        summary: "Enrol every member of a cohort as students",
        params: z.object({ courseId: zId }),
        body: z.object({ cohortId: zId }),
        response: { 200: z.object({ enrolled: z.number().int() }) },
      },
    },
    async (req) => {
      const created = await req.tenant(async (tx) => {
        const course = await loadCourseWith(tx, req, req.params.courseId, "course:enrol_manage");
        const members = await tx.select({ userId: cohortMembers.userId }).from(cohortMembers).where(eq(cohortMembers.cohortId, req.body.cohortId));
        const out: string[] = [];
        for (const m of members) {
          if (await enrolUser(tx, { organizationId: req.org.id, course, userId: m.userId, method: "cohort", cohortId: req.body.cohortId })) out.push(m.userId);
        }
        await audit(tx, req, "enrolment.cohort", { type: "course", id: course.id }, { cohortId: req.body.cohortId, count: out.length });
        return out;
      });
      for (const userId of created) await emit("user.enrolled", { organizationId: req.org.id, courseId: req.params.courseId, userId });
      return { enrolled: created.length };
    },
  );
};
