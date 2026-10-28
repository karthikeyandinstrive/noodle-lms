import { hash, verify } from "@node-rs/argon2";
import { and, asc, count, desc, eq, ilike, inArray, isNull, or } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import {
  ARGON2_OPTIONS,
  activities,
  activityCompletions,
  courseCategories,
  courseSections,
  courses,
  createContext,
  enrolments,
  getSystemContext,
  groupMembers,
  groups,
  roleAssignments,
  roles,
  users,
  type DB,
} from "@lms/db";
import { z } from "zod";
import { requireUser } from "../../core/auth";
import { beforeActivitiesDeleted } from "../../core/activity-types";
import { audit } from "../../core/audit";
import { badRequest, forbidden, must, notFound } from "../../core/errors";
import { emit } from "../../core/events";
import { notify } from "../../core/notify";
import { capabilityMap, hasCapability, requireCapability } from "../../core/rbac";
import { cleanHtml } from "../../core/sanitize";
import { assertWithinLimits } from "../billing/service";
import { offset, ok, paged, zDate, zDateInput, zId, zNullableDate, zOk, zPagination, zUserSummary, patchSchema } from "../../core/schemas";
import {
  createCourse,
  ENROLABLE_ROLES,
  enrolUser,
  loadCourse,
  loadCourseWith,
  nextSectionPosition,
  sectionsOf,
  setEnrolmentStatus,
  unenrolUser,
} from "./service";

// ─── Schemas ────────────────────────────────────────────────────────────────

const zCourse = z.object({
  id: zId,
  categoryId: zId.nullable(),
  fullname: z.string(),
  shortname: z.string(),
  summary: z.string().nullable(),
  format: z.string(),
  visible: z.boolean(),
  startDate: zNullableDate,
  endDate: zNullableDate,
  imageFileId: zId.nullable(),
  enableCompletion: z.boolean(),
  selfEnrol: z.enum(["open", "key", "closed"]),
  priceCents: z.number().int().nullable(),
  currency: z.string().nullable(),
  createdAt: zDate,
});

const zCourseInput = z.object({
  categoryId: zId.nullable().optional(),
  fullname: z.string().trim().min(1).max(255),
  shortname: z.string().trim().min(1).max(100),
  summary: z.string().max(20_000).nullable().optional(),
  format: z.enum(["topics", "weeks", "single"]).default("topics"),
  visible: z.boolean().default(true),
  startDate: zDateInput.nullable().optional(),
  endDate: zDateInput.nullable().optional(),
  imageFileId: zId.nullable().optional(),
  enableCompletion: z.boolean().default(true),
  selfEnrol: z.enum(["open", "key", "closed"]).default("closed"),
  /** Plain enrolment key; stored hashed. */
  enrolmentKey: z.string().min(4).max(100).nullable().optional(),
  priceCents: z.number().int().min(0).nullable().optional(),
  currency: z.string().length(3).toUpperCase().nullable().optional(),
});

const zCategory = z.object({
  id: zId,
  parentId: zId.nullable(),
  name: z.string(),
  description: z.string().nullable(),
  sortOrder: z.number().int(),
  visible: z.boolean(),
});

const zSection = z.object({ id: zId, title: z.string(), summary: z.string().nullable(), position: z.number().int(), visible: z.boolean() });

const zActivitySummary = z.object({
  id: zId,
  sectionId: zId,
  type: z.string(),
  name: z.string(),
  position: z.number().int(),
  visible: z.boolean(),
  availableFrom: zNullableDate,
  availableUntil: zNullableDate,
  completionRule: z.string(),
  completion: z.string().nullable(),
});

const zParticipant = zUserSummary.extend({
  roles: z.array(z.string()),
  status: z.enum(["active", "suspended"]),
  method: z.string(),
  enrolledAt: zDate,
  lastLoginAt: zNullableDate,
});

const zGroup = z.object({ id: zId, name: z.string(), description: z.string().nullable(), memberIds: z.array(zId) });

const courseCaps = [
  "course:update",
  "course:delete",
  "course:view_hidden",
  "course:enrol_manage",
  "course:view_participants",
  "course:manage_groups",
  "activity:create",
  "activity:grade",
  "grades:view_all",
  "grades:view_own",
  "grades:edit",
  "report:view_course",
  "badge:manage",
  "badge:award",
  "question:manage",
  "completion:override",
  "role:assign",
  "calendar:manage_course",
  "notification:send",
  "course:backup",
  "message:send",
  "lti:manage_course_tools",
] as const;

function toCourse(c: typeof courses.$inferSelect) {
  return { ...c, selfEnrol: c.selfEnrol as "open" | "key" | "closed" };
}

const courseIdParam = z.object({ courseId: zId });

export const routes: FastifyPluginAsyncZod = async (app) => {
  // ─── Categories ─────────────────────────────────────────────────────────

  app.get("/categories", { schema: { tags: ["Courses"], summary: "List course categories", response: { 200: z.array(zCategory) } } }, (req) =>
    req.tenant((tx) => tx.select().from(courseCategories).orderBy(asc(courseCategories.sortOrder), asc(courseCategories.name))),
  );

  const zCategoryInput = z.object({
    parentId: zId.nullable().optional(),
    name: z.string().trim().min(1).max(255),
    description: z.string().max(5000).nullable().optional(),
    sortOrder: z.number().int().default(0),
    visible: z.boolean().default(true),
  });

  app.post(
    "/categories",
    { schema: { tags: ["Courses"], summary: "Create a category", body: zCategoryInput, response: { 201: zCategory } } },
    async (req, reply) => {
      requireUser(req);
      const category = await req.tenant(async (tx) => {
        const system = await getSystemContext(tx, req.org.id);
        let parentCtx = system.id;
        if (req.body.parentId) {
          const parent = must((await tx.select().from(courseCategories).where(eq(courseCategories.id, req.body.parentId)).limit(1))[0], "Category");
          parentCtx = parent.contextId;
        }
        await requireCapability(tx, req, "category:manage", parentCtx);
        const id = crypto.randomUUID();
        const ctx = await createContext(tx, { organizationId: req.org.id, level: "category", instanceId: id, parentId: parentCtx });
        const [row] = await tx.insert(courseCategories).values({ ...req.body, id, organizationId: req.org.id, contextId: ctx.id }).returning();
        await audit(tx, req, "category.created", { type: "category", id });
        return row!;
      });
      return reply.status(201).send(category);
    },
  );

  app.patch(
    "/categories/:id",
    { schema: { tags: ["Courses"], summary: "Update a category", params: z.object({ id: zId }), body: patchSchema(zCategoryInput.omit({ parentId: true })), response: { 200: zCategory } } },
    (req) =>
      req.tenant(async (tx) => {
        const cat = must((await tx.select().from(courseCategories).where(eq(courseCategories.id, req.params.id)).limit(1))[0], "Category");
        await requireCapability(tx, req, "category:manage", cat.contextId);
        const [row] = await tx.update(courseCategories).set(req.body).where(eq(courseCategories.id, cat.id)).returning();
        return row!;
      }),
  );

  app.delete(
    "/categories/:id",
    { schema: { tags: ["Courses"], summary: "Delete an empty category", params: z.object({ id: zId }), response: { 200: zOk } } },
    async (req) => {
      await req.tenant(async (tx) => {
        const cat = must((await tx.select().from(courseCategories).where(eq(courseCategories.id, req.params.id)).limit(1))[0], "Category");
        await requireCapability(tx, req, "category:manage", cat.contextId);
        const [{ n }] = (await tx.select({ n: count() }).from(courses).where(eq(courses.categoryId, cat.id))) as [{ n: number }];
        if (n > 0) throw badRequest("Move or delete the courses in this category first");
        await tx.delete(courseCategories).where(eq(courseCategories.id, cat.id));
        await audit(tx, req, "category.deleted", { type: "category", id: cat.id });
      });
      return ok;
    },
  );

  // ─── Courses ────────────────────────────────────────────────────────────

  app.get(
    "/courses",
    {
      schema: {
        tags: ["Courses"],
        summary: "List courses (catalog, or only mine)",
        querystring: zPagination.extend({
          search: z.string().max(100).optional(),
          categoryId: zId.optional(),
          mine: z.coerce.boolean().optional(),
        }),
        response: { 200: paged(zCourse.extend({ enrolled: z.boolean() })) },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const q = req.query;
        const system = await getSystemContext(tx, req.org.id);
        const seeHidden = await hasCapability(tx, req, "course:view_hidden", system.id);
        const myCourseIds = req.user
          ? (await tx.select({ id: enrolments.courseId }).from(enrolments).where(and(eq(enrolments.userId, req.user.id), eq(enrolments.status, "active")))).map((r) => r.id)
          : [];
        if (q.mine && !myCourseIds.length) return { items: [], total: 0, page: q.page, pageSize: q.pageSize };

        const where = and(
          q.mine ? inArray(courses.id, myCourseIds) : undefined,
          seeHidden ? undefined : q.mine ? undefined : eq(courses.visible, true),
          q.categoryId ? eq(courses.categoryId, q.categoryId) : undefined,
          q.search ? or(ilike(courses.fullname, `%${q.search}%`), ilike(courses.shortname, `%${q.search}%`)) : undefined,
        );
        const [rows, [{ total }]] = (await Promise.all([
          tx.select().from(courses).where(where).orderBy(desc(courses.createdAt)).limit(q.pageSize).offset(offset(q)),
          tx.select({ total: count() }).from(courses).where(where),
        ])) as [(typeof courses.$inferSelect)[], [{ total: number }]];
        const mine = new Set(myCourseIds);
        return { items: rows.map((c) => ({ ...toCourse(c), enrolled: mine.has(c.id) })), total, page: q.page, pageSize: q.pageSize };
      }),
  );

  app.post(
    "/courses",
    { schema: { tags: ["Courses"], summary: "Create a course", body: zCourseInput, response: { 201: zCourse } } },
    async (req, reply) => {
      const { enrolmentKey, ...input } = req.body;
      const course = await req.tenant(async (tx) => {
        const c = await createCourse(tx, req, {
          ...input,
          summary: input.summary ? cleanHtml(input.summary) : null,
          enrolmentKeyHash: enrolmentKey ? await hash(enrolmentKey, ARGON2_OPTIONS) : null,
        });
        // Checked after createCourse (which enforces course:create first) so callers without the
        // capability get 403, not 402. The new row is already counted, so add 0; a 402 rolls it back.
        await assertWithinLimits(tx, req.org.id, "courses", 0);
        await audit(tx, req, "course.created", { type: "course", id: c.id });
        return c;
      });
      await emit("course.created", { organizationId: req.org.id, courseId: course.id, userId: req.user?.id });
      return reply.status(201).send(toCourse(course));
    },
  );

  app.get(
    "/courses/:courseId",
    {
      schema: {
        tags: ["Courses"],
        summary: "Course overview: settings, sections, activities, my capabilities",
        params: courseIdParam,
        response: {
          200: z.object({
            course: zCourse,
            sections: z.array(zSection.extend({ activities: z.array(zActivitySummary) })),
            enrolled: z.boolean(),
            capabilities: z.record(z.string(), z.boolean()),
            /** Course permission context; only sent to users who can assign roles here. */
            contextId: zId.nullable(),
          }),
        },
      },
    },
    async (req) => {
      return req.tenant(async (tx) => {
        const courseId = req.params.courseId;
        const course = must((await tx.select().from(courses).where(eq(courses.id, courseId)).limit(1))[0], "Course");
        const canView = await hasCapability(tx, req, "course:view", course.contextId);
        // Not yet enrolled: allow a public preview of visible courses (catalog page with enrol button).
        if (!canView && !course.visible) throw notFound("Course");
        const caps = await capabilityMap(tx, req, [...courseCaps], course.contextId);
        const seeHidden = caps["course:view_hidden"] === true;
        if (!course.visible && !seeHidden) throw notFound("Course");

        const enrolled = req.user
          ? !!(await tx.select({ id: enrolments.id }).from(enrolments).where(and(eq(enrolments.courseId, courseId), eq(enrolments.userId, req.user.id), eq(enrolments.status, "active"))).limit(1))[0]
          : false;

        const sections = (await sectionsOf(tx, courseId)).filter((s) => s.visible || seeHidden);
        const acts = canView
          ? await tx.select().from(activities).where(eq(activities.courseId, courseId)).orderBy(asc(activities.position))
          : [];
        const completion = req.user && acts.length
          ? await tx.select().from(activityCompletions).where(and(eq(activityCompletions.userId, req.user.id), inArray(activityCompletions.activityId, acts.map((a) => a.id))))
          : [];
        const stateOf = new Map(completion.map((c) => [c.activityId, c.state]));

        return {
          course: toCourse(course),
          enrolled,
          capabilities: { ...caps, "course:view": canView } as Record<string, boolean>,
          contextId: caps["role:assign"] ? course.contextId : null,
          sections: sections.map((s) => ({
            ...s,
            activities: acts
              .filter((a) => a.sectionId === s.id && (a.visible || seeHidden))
              .map((a) => ({ ...a, completion: a.completionRule === "none" ? null : (stateOf.get(a.id) ?? "incomplete") })),
          })),
        };
      });
    },
  );

  app.patch(
    "/courses/:courseId",
    { schema: { tags: ["Courses"], summary: "Update course settings", params: courseIdParam, body: patchSchema(zCourseInput), response: { 200: zCourse } } },
    (req) =>
      req.tenant(async (tx) => {
        const course = await loadCourseWith(tx, req, req.params.courseId, "course:update");
        const { enrolmentKey, ...input } = req.body;
        const patch: Partial<typeof courses.$inferInsert> = { ...input };
        if (input.summary !== undefined) patch.summary = input.summary ? cleanHtml(input.summary) : null;
        if (enrolmentKey !== undefined) patch.enrolmentKeyHash = enrolmentKey ? await hash(enrolmentKey, ARGON2_OPTIONS) : null;
        if (input.priceCents !== undefined || input.currency !== undefined) {
          const system = await getSystemContext(tx, req.org.id);
          await requireCapability(tx, req, "payment:manage", system.id);
        }
        const [row] = await tx.update(courses).set(patch).where(eq(courses.id, course.id)).returning();
        await audit(tx, req, "course.updated", { type: "course", id: course.id }, { fields: Object.keys(req.body) });
        return toCourse(row!);
      }),
  );

  app.delete(
    "/courses/:courseId",
    { schema: { tags: ["Courses"], summary: "Delete a course and all its data", params: courseIdParam, response: { 200: zOk } } },
    async (req) => {
      await req.tenant(async (tx) => {
        const course = await loadCourseWith(tx, req, req.params.courseId, "course:delete");
        await beforeActivitiesDeleted(tx, await tx.select().from(activities).where(eq(activities.courseId, course.id)));
        await tx.delete(courses).where(eq(courses.id, course.id));
        await audit(tx, req, "course.deleted", { type: "course", id: course.id }, { shortname: course.shortname });
      });
      return ok;
    },
  );

  // ─── Sections ───────────────────────────────────────────────────────────

  const zSectionInput = z.object({
    title: z.string().trim().min(1).max(255),
    summary: z.string().max(20_000).nullable().optional(),
    visible: z.boolean().default(true),
  });

  app.post(
    "/courses/:courseId/sections",
    { schema: { tags: ["Courses"], summary: "Add a section", params: courseIdParam, body: zSectionInput, response: { 201: zSection } } },
    async (req, reply) => {
      const section = await req.tenant(async (tx) => {
        const course = await loadCourseWith(tx, req, req.params.courseId, "course:update");
        const [row] = await tx
          .insert(courseSections)
          .values({
            ...req.body,
            summary: req.body.summary ? cleanHtml(req.body.summary) : null,
            organizationId: req.org.id,
            courseId: course.id,
            position: await nextSectionPosition(tx, course.id),
          })
          .returning();
        return row!;
      });
      return reply.status(201).send(section);
    },
  );

  app.patch(
    "/courses/:courseId/sections/:sectionId",
    {
      schema: {
        tags: ["Courses"],
        summary: "Update a section",
        params: courseIdParam.extend({ sectionId: zId }),
        body: patchSchema(zSectionInput),
        response: { 200: zSection },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const course = await loadCourseWith(tx, req, req.params.courseId, "course:update");
        const patch = { ...req.body, ...(req.body.summary !== undefined ? { summary: req.body.summary ? cleanHtml(req.body.summary) : null } : {}) };
        const [row] = await tx
          .update(courseSections)
          .set(patch)
          .where(and(eq(courseSections.id, req.params.sectionId), eq(courseSections.courseId, course.id)))
          .returning();
        return must(row, "Section");
      }),
  );

  app.delete(
    "/courses/:courseId/sections/:sectionId",
    { schema: { tags: ["Courses"], summary: "Delete a section and its activities", params: courseIdParam.extend({ sectionId: zId }), response: { 200: zOk } } },
    async (req) => {
      await req.tenant(async (tx) => {
        const course = await loadCourseWith(tx, req, req.params.courseId, "course:update");
        const sections = await sectionsOf(tx, course.id);
        if (sections.length <= 1) throw badRequest("A course needs at least one section");
        await tx.delete(courseSections).where(and(eq(courseSections.id, req.params.sectionId), eq(courseSections.courseId, course.id)));
      });
      return ok;
    },
  );

  app.put(
    "/courses/:courseId/sections/order",
    {
      schema: {
        tags: ["Courses"],
        summary: "Reorder sections",
        params: courseIdParam,
        body: z.object({ sectionIds: z.array(zId).min(1) }),
        response: { 200: zOk },
      },
    },
    async (req) => {
      await req.tenant(async (tx) => {
        const course = await loadCourseWith(tx, req, req.params.courseId, "course:update");
        for (const [position, id] of req.body.sectionIds.entries()) {
          await tx.update(courseSections).set({ position }).where(and(eq(courseSections.id, id), eq(courseSections.courseId, course.id)));
        }
      });
      return ok;
    },
  );

  // ─── Enrolment ──────────────────────────────────────────────────────────

  app.post(
    "/courses/:courseId/enrol",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["Enrolment"],
        summary: "Self-enrol (open courses, or with the enrolment key)",
        params: courseIdParam,
        body: z.object({ key: z.string().max(100).optional() }),
        response: { 200: zOk },
      },
    },
    async (req) => {
      const me = requireUser(req);
      const created = await req.tenant(async (tx) => {
        const course = must((await tx.select().from(courses).where(and(eq(courses.id, req.params.courseId), eq(courses.visible, true))).limit(1))[0], "Course");
        if (course.priceCents && course.priceCents > 0) throw badRequest("This course requires payment");
        if (course.selfEnrol === "closed") throw forbidden("Self-enrolment is not available for this course");
        if (course.selfEnrol === "key") {
          const okKey = course.enrolmentKeyHash && req.body.key && (await verify(course.enrolmentKeyHash, req.body.key, ARGON2_OPTIONS).catch(() => false));
          if (!okKey) throw badRequest("Incorrect enrolment key");
        }
        return enrolUser(tx, { organizationId: req.org.id, course, userId: me.id, method: "self" });
      });
      if (created) await emit("user.enrolled", { organizationId: req.org.id, courseId: req.params.courseId, userId: me.id });
      return ok;
    },
  );

  app.get(
    "/courses/:courseId/participants",
    {
      schema: {
        tags: ["Enrolment"],
        summary: "Course participants with roles",
        params: courseIdParam,
        querystring: zPagination.extend({ search: z.string().max(100).optional(), role: z.string().optional() }),
        response: { 200: paged(zParticipant) },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const course = await loadCourseWith(tx, req, req.params.courseId, "course:view_participants");
        const canSeeEmails = await hasCapability(tx, req, "course:enrol_manage", course.contextId);
        const q = req.query;
        const where = and(
          eq(enrolments.courseId, course.id),
          q.search ? or(ilike(users.firstName, `%${q.search}%`), ilike(users.lastName, `%${q.search}%`), ilike(users.email, `%${q.search}%`)) : undefined,
        );
        const rows = await tx
          .select({ e: enrolments, u: users })
          .from(enrolments)
          .innerJoin(users, eq(users.id, enrolments.userId))
          .where(where)
          .orderBy(asc(users.lastName), asc(users.firstName));
        const roleRows = rows.length
          ? await tx
              .select({ userId: roleAssignments.userId, shortname: roles.shortname })
              .from(roleAssignments)
              .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
              .where(and(eq(roleAssignments.contextId, course.contextId), inArray(roleAssignments.userId, rows.map((r) => r.u.id))))
          : [];
        const rolesOf = new Map<string, string[]>();
        for (const r of roleRows) rolesOf.set(r.userId, [...(rolesOf.get(r.userId) ?? []), r.shortname]);
        const filtered = q.role ? rows.filter((r) => rolesOf.get(r.u.id)?.includes(q.role!)) : rows;
        const pageRows = filtered.slice(offset(q), offset(q) + q.pageSize);
        return {
          items: pageRows.map(({ e, u }) => ({
            id: u.id,
            firstName: u.firstName,
            lastName: u.lastName,
            email: canSeeEmails ? u.email : undefined,
            roles: rolesOf.get(u.id) ?? [],
            status: e.status,
            method: e.method,
            enrolledAt: e.createdAt,
            lastLoginAt: canSeeEmails ? u.lastLoginAt : null,
          })),
          total: filtered.length,
          page: q.page,
          pageSize: q.pageSize,
        };
      }),
  );

  app.post(
    "/courses/:courseId/enrolments",
    {
      schema: {
        tags: ["Enrolment"],
        summary: "Manually enrol users",
        params: courseIdParam,
        body: z.object({
          userIds: z.array(zId).min(1).max(500),
          role: z.enum(ENROLABLE_ROLES).default("student"),
          timeEnd: zDateInput.nullable().optional(),
        }),
        response: { 200: z.object({ enrolled: z.number().int() }) },
      },
    },
    async (req) => {
      const me = requireUser(req);
      const created = await req.tenant(async (tx) => {
        const course = await loadCourseWith(tx, req, req.params.courseId, "course:enrol_manage");
        if (req.body.role !== "student") await requireCapability(tx, req, "role:assign", course.contextId);
        const valid = await tx.select({ id: users.id }).from(users).where(and(inArray(users.id, req.body.userIds), isNull(users.deletedAt)));
        const out: string[] = [];
        for (const { id } of valid) {
          if (await enrolUser(tx, { organizationId: req.org.id, course, userId: id, method: "manual", role: req.body.role, timeEnd: req.body.timeEnd, assignedBy: me.id })) out.push(id);
        }
        if (out.length) {
          await notify(tx, { organizationId: req.org.id, userIds: out, type: "enrolment", title: `You were enrolled in ${course.fullname}`, link: `/courses/${course.id}` });
        }
        await audit(tx, req, "enrolment.manual", { type: "course", id: course.id }, { userIds: out, role: req.body.role });
        return out;
      });
      for (const userId of created) await emit("user.enrolled", { organizationId: req.org.id, courseId: req.params.courseId, userId });
      return { enrolled: created.length };
    },
  );

  app.patch(
    "/courses/:courseId/enrolments/:userId",
    {
      schema: {
        tags: ["Enrolment"],
        summary: "Suspend/reactivate an enrolment or change course roles",
        params: courseIdParam.extend({ userId: zId }),
        body: z.object({ status: z.enum(["active", "suspended"]).optional(), roles: z.array(z.enum(ENROLABLE_ROLES)).min(1).optional() }),
        response: { 200: zOk },
      },
    },
    async (req) => {
      await req.tenant(async (tx) => {
        const course = await loadCourseWith(tx, req, req.params.courseId, "course:enrol_manage");
        if (req.body.status) await setEnrolmentStatus(tx, course, req.params.userId, req.body.status);
        if (req.body.roles) {
          await requireCapability(tx, req, "role:assign", course.contextId);
          const roleRows = await tx.select().from(roles).where(inArray(roles.shortname, req.body.roles));
          await tx.delete(roleAssignments).where(and(eq(roleAssignments.userId, req.params.userId), eq(roleAssignments.contextId, course.contextId)));
          await tx.insert(roleAssignments).values(
            roleRows.map((r) => ({ organizationId: req.org.id, userId: req.params.userId, roleId: r.id, contextId: course.contextId, assignedBy: req.user!.id })),
          );
        }
        await audit(tx, req, "enrolment.updated", { type: "course", id: course.id }, { userId: req.params.userId, ...req.body });
      });
      return ok;
    },
  );

  app.delete(
    "/courses/:courseId/enrolments/:userId",
    { schema: { tags: ["Enrolment"], summary: "Unenrol a user", params: courseIdParam.extend({ userId: zId }), response: { 200: zOk } } },
    async (req) => {
      await req.tenant(async (tx) => {
        const course = await loadCourseWith(tx, req, req.params.courseId, "course:enrol_manage");
        await unenrolUser(tx, course, req.params.userId);
        await audit(tx, req, "enrolment.removed", { type: "course", id: course.id }, { userId: req.params.userId });
      });
      await emit("user.unenrolled", { organizationId: req.org.id, courseId: req.params.courseId, userId: req.params.userId });
      return ok;
    },
  );

  app.post(
    "/courses/:courseId/unenrol-self",
    { schema: { tags: ["Enrolment"], summary: "Leave a self-enrolled course", params: courseIdParam, response: { 200: zOk } } },
    async (req) => {
      const me = requireUser(req);
      await req.tenant(async (tx) => {
        const course = await loadCourse(tx, req, req.params.courseId);
        const [e] = await tx.select().from(enrolments).where(and(eq(enrolments.courseId, course.id), eq(enrolments.userId, me.id))).limit(1);
        if (!e || e.method !== "self") throw badRequest("You can only leave courses you enrolled in yourself");
        await unenrolUser(tx, course, me.id);
      });
      await emit("user.unenrolled", { organizationId: req.org.id, courseId: req.params.courseId, userId: me.id });
      return ok;
    },
  );

  // ─── Groups ─────────────────────────────────────────────────────────────

  async function groupsWithMembers(tx: DB, courseId: string) {
    const gs = await tx.select().from(groups).where(eq(groups.courseId, courseId)).orderBy(asc(groups.name));
    const members = gs.length ? await tx.select().from(groupMembers).where(inArray(groupMembers.groupId, gs.map((g) => g.id))) : [];
    return gs.map((g) => ({ id: g.id, name: g.name, description: g.description, memberIds: members.filter((m) => m.groupId === g.id).map((m) => m.userId) }));
  }

  app.get(
    "/courses/:courseId/groups",
    { schema: { tags: ["Groups"], summary: "List groups", params: courseIdParam, response: { 200: z.array(zGroup) } } },
    (req) =>
      req.tenant(async (tx) => {
        const course = await loadCourse(tx, req, req.params.courseId);
        return groupsWithMembers(tx, course.id);
      }),
  );

  const zGroupInput = z.object({ name: z.string().trim().min(1).max(255), description: z.string().max(5000).nullable().optional(), memberIds: z.array(zId).optional() });

  app.post(
    "/courses/:courseId/groups",
    { schema: { tags: ["Groups"], summary: "Create a group", params: courseIdParam, body: zGroupInput, response: { 201: zGroup } } },
    async (req, reply) => {
      const group = await req.tenant(async (tx) => {
        const course = await loadCourseWith(tx, req, req.params.courseId, "course:manage_groups");
        const [g] = await tx.insert(groups).values({ organizationId: req.org.id, courseId: course.id, name: req.body.name, description: req.body.description ?? null }).returning();
        await setGroupMembers(tx, req.org.id, course.id, g!.id, req.body.memberIds ?? []);
        return (await groupsWithMembers(tx, course.id)).find((x) => x.id === g!.id)!;
      });
      return reply.status(201).send(group);
    },
  );

  app.patch(
    "/courses/:courseId/groups/:groupId",
    { schema: { tags: ["Groups"], summary: "Update a group and its members", params: courseIdParam.extend({ groupId: zId }), body: patchSchema(zGroupInput), response: { 200: zGroup } } },
    (req) =>
      req.tenant(async (tx) => {
        const course = await loadCourseWith(tx, req, req.params.courseId, "course:manage_groups");
        const { memberIds, ...rest } = req.body;
        const [g] = await tx.update(groups).set(rest).where(and(eq(groups.id, req.params.groupId), eq(groups.courseId, course.id))).returning();
        must(g, "Group");
        if (memberIds) await setGroupMembers(tx, req.org.id, course.id, g!.id, memberIds);
        return (await groupsWithMembers(tx, course.id)).find((x) => x.id === g!.id)!;
      }),
  );

  app.delete(
    "/courses/:courseId/groups/:groupId",
    { schema: { tags: ["Groups"], summary: "Delete a group", params: courseIdParam.extend({ groupId: zId }), response: { 200: zOk } } },
    async (req) => {
      await req.tenant(async (tx) => {
        const course = await loadCourseWith(tx, req, req.params.courseId, "course:manage_groups");
        await tx.delete(groups).where(and(eq(groups.id, req.params.groupId), eq(groups.courseId, course.id)));
      });
      return ok;
    },
  );
};

// Only enrolled users can be group members.
async function setGroupMembers(tx: DB, organizationId: string, courseId: string, groupId: string, memberIds: string[]) {
  await tx.delete(groupMembers).where(eq(groupMembers.groupId, groupId));
  if (!memberIds.length) return;
  const enrolled = await tx
    .select({ userId: enrolments.userId })
    .from(enrolments)
    .where(and(eq(enrolments.courseId, courseId), inArray(enrolments.userId, memberIds)));
  if (enrolled.length) await tx.insert(groupMembers).values(enrolled.map((e) => ({ organizationId, groupId, userId: e.userId })));
}
