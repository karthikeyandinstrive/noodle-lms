import { and, asc, desc, eq, inArray, max } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { courses, enrolments, gradeCategories, gradeGrades, gradeHistory, gradeItems, users, type DB } from "@lms/db";
import { z } from "zod";
import { audit } from "../../core/audit";
import { requireUser } from "../../core/auth";
import { badRequest, conflict, notFound } from "../../core/errors";
import { emit, type EventMap } from "../../core/events";
import { notify } from "../../core/notify";
import { hasCapability, requireCapability } from "../../core/rbac";
import { cleanHtml } from "../../core/sanitize";
import { offset, ok, paged, zDate, zId, zOk, zPagination, zUserSummary, patchSchema } from "../../core/schemas";
import { loadCourse, loadCourseWith } from "../courses/service";
import { AGGREGATIONS, formatGrade, toCsv, toPercent } from "./aggregate";
import {
  courseGradebook,
  courseTotalItem,
  ensureCategoryItem,
  gradebookUsers,
  isLeafItem,
  loadGradeCategory,
  loadGradeItem,
  recalculateCourseTotals,
  rootCategory,
  type GradeCategoryRow,
  type GradeItemRow,
} from "./service";

// ─── Schemas ────────────────────────────────────────────────────────────────

const zItemType = z.enum(["activity", "manual", "category", "course"]);
const zAggregation = z.enum(AGGREGATIONS);

const zItem = z.object({
  id: zId,
  categoryId: zId.nullable(),
  type: zItemType,
  activityId: zId.nullable(),
  name: z.string(),
  gradeMax: z.number(),
  gradeMin: z.number(),
  gradePass: z.number().nullable(),
  weight: z.number(),
  hidden: z.boolean(),
  locked: z.boolean(),
  position: z.number().int(),
});

const zCategory = z.object({
  id: zId,
  parentId: zId.nullable(),
  name: z.string(),
  aggregation: zAggregation,
  dropLowest: z.number().int(),
  /** Grade item holding this category's total (null for the root, whose total is the course item). */
  itemId: zId.nullable(),
  /** Weight of this category inside its parent (weighted mean). */
  weight: z.number().nullable(),
});

const zGrade = z.object({
  itemId: zId,
  userId: zId,
  rawGrade: z.number().nullable(),
  finalGrade: z.number().nullable(),
  overridden: z.boolean(),
  feedback: z.string().nullable(),
  updatedAt: zDate,
});

const zUserReportRow = zItem.pick({ id: true, type: true, activityId: true, name: true, gradeMax: true, gradeMin: true, gradePass: true, weight: true, categoryId: true }).extend({
  grade: z.number().nullable(),
  percentage: z.number().nullable(),
  feedback: z.string().nullable(),
  overridden: z.boolean(),
  hidden: z.boolean(),
});

const zUserReport = z.object({
  course: z.object({ id: zId, fullname: z.string() }),
  user: zUserSummary,
  categories: z.array(zCategory),
  items: z.array(zUserReportRow),
  courseTotal: z.object({ grade: z.number().nullable(), gradeMax: z.number(), percentage: z.number().nullable() }).nullable(),
});

const courseIdParam = z.object({ courseId: zId });
const itemUserParams = z.object({ itemId: zId, userId: zId });

const toItem = (i: GradeItemRow) => ({ ...i, type: i.type as z.infer<typeof zItemType> });

function toCategories(categories: GradeCategoryRow[], items: GradeItemRow[]) {
  const itemOf = new Map(items.filter((i) => i.type === "category" && i.categoryId).map((i) => [i.categoryId!, i]));
  return categories.map((c) => ({
    id: c.id,
    parentId: c.parentId,
    name: c.name,
    aggregation: c.aggregation as z.infer<typeof zAggregation>,
    dropLowest: c.dropLowest,
    itemId: itemOf.get(c.id)?.id ?? null,
    weight: c.parentId ? (itemOf.get(c.id)?.weight ?? 1) : null,
  }));
}

/** Display order: leaf items by position, then category totals, course total last. */
function displayOrder(items: GradeItemRow[]) {
  const rank = (i: GradeItemRow) => (i.type === "course" ? 2 : i.type === "category" ? 1 : 0);
  return [...items].sort((a, b) => rank(a) - rank(b) || a.position - b.position || a.createdAt.getTime() - b.createdAt.getTime());
}

async function isActiveParticipant(tx: DB, courseId: string, userId: string) {
  const [row] = await tx
    .select({ status: enrolments.status })
    .from(enrolments)
    .where(and(eq(enrolments.courseId, courseId), eq(enrolments.userId, userId)))
    .limit(1);
  return row?.status === "active";
}

/** Builds the user report. `includeHidden` only for viewers holding grades:view_all. */
async function userReport(tx: DB, course: typeof courses.$inferSelect, userId: string, includeHidden: boolean) {
  const user = (await tx.select({ id: users.id, firstName: users.firstName, lastName: users.lastName }).from(users).where(eq(users.id, userId)).limit(1))[0];
  if (!user) throw notFound("User");
  const { categories, items } = await courseGradebook(tx, course.id);
  const visible = items.filter((i) => includeHidden || !i.hidden);
  const grades = visible.length
    ? await tx.select().from(gradeGrades).where(and(eq(gradeGrades.userId, userId), inArray(gradeGrades.itemId, visible.map((i) => i.id))))
    : [];
  const gradeOf = new Map(grades.map((g) => [g.itemId, g]));
  const rows = displayOrder(visible).filter((i) => i.type !== "course");
  const total = visible.find((i) => i.type === "course");
  const totalGrade = total ? (gradeOf.get(total.id)?.finalGrade ?? null) : null;
  return {
    course: { id: course.id, fullname: course.fullname },
    user,
    categories: toCategories(categories, items),
    items: rows.map((i) => {
      const g = gradeOf.get(i.id);
      return {
        ...toItem(i),
        grade: g?.finalGrade ?? null,
        percentage: toPercent(g?.finalGrade ?? null, i.gradeMin, i.gradeMax),
        feedback: g?.feedback ?? null,
        overridden: g?.overridden ?? false,
      };
    }),
    courseTotal: total ? { grade: totalGrade, gradeMax: total.gradeMax, percentage: toPercent(totalGrade, total.gradeMin, total.gradeMax) } : null,
  };
}

async function categoryInCourse(tx: DB, categoryId: string, courseId: string) {
  const [cat] = await tx
    .select()
    .from(gradeCategories)
    .where(and(eq(gradeCategories.id, categoryId), eq(gradeCategories.courseId, courseId)))
    .limit(1);
  if (!cat) throw badRequest("Category is not part of this course");
  return cat;
}

export const routes: FastifyPluginAsyncZod = async (app) => {
  // ─── Reports ────────────────────────────────────────────────────────────

  app.get(
    "/courses/:courseId",
    {
      schema: {
        tags: ["Gradebook"],
        summary: "Grader report: grade items × learners (paged by learner)",
        params: courseIdParam,
        querystring: zPagination.extend({ search: z.string().max(100).optional() }),
        response: {
          200: z.object({
            course: z.object({ id: zId, fullname: z.string() }),
            categories: z.array(zCategory),
            items: z.array(zItem),
            users: paged(zUserSummary),
            grades: z.array(zGrade),
            capabilities: z.object({ edit: z.boolean(), export: z.boolean() }),
          }),
        },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const course = await loadCourseWith(tx, req, req.params.courseId, "grades:view_all");
        const q = req.query;
        const [{ categories, items }, all, canEdit, canExport] = await Promise.all([
          courseGradebook(tx, course.id),
          gradebookUsers(tx, course),
          hasCapability(tx, req, "grades:edit", course.contextId),
          hasCapability(tx, req, "grades:export", course.contextId),
        ]);
        const needle = q.search?.toLowerCase().trim();
        const filtered = needle
          ? all.filter((u) => `${u.firstName} ${u.lastName} ${u.email}`.toLowerCase().includes(needle))
          : all;
        const page = filtered.slice(offset(q), offset(q) + q.pageSize);
        const grades =
          page.length && items.length
            ? await tx
                .select()
                .from(gradeGrades)
                .where(and(inArray(gradeGrades.itemId, items.map((i) => i.id)), inArray(gradeGrades.userId, page.map((u) => u.id))))
            : [];
        return {
          course: { id: course.id, fullname: course.fullname },
          categories: toCategories(categories, items),
          items: displayOrder(items).map(toItem),
          users: { items: page, total: filtered.length, page: q.page, pageSize: q.pageSize },
          grades,
          capabilities: { edit: canEdit, export: canExport },
        };
      }),
  );

  app.get(
    "/courses/:courseId/me",
    {
      schema: { tags: ["Gradebook"], summary: "My user report for a course (hidden items omitted)", params: courseIdParam, response: { 200: zUserReport } },
    },
    (req) =>
      req.tenant(async (tx) => {
        const me = requireUser(req);
        const course = await loadCourse(tx, req, req.params.courseId);
        await requireCapability(tx, req, "grades:view_own", course.contextId);
        return userReport(tx, course, me.id, false);
      }),
  );

  app.get(
    "/courses/:courseId/users/:userId",
    {
      schema: {
        tags: ["Gradebook"],
        summary: "User report of one learner (teacher view, includes hidden items)",
        params: courseIdParam.extend({ userId: zId }),
        response: { 200: zUserReport },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const course = await loadCourseWith(tx, req, req.params.courseId, "grades:view_all");
        if (!(await isActiveParticipant(tx, course.id, req.params.userId))) throw notFound("User");
        return userReport(tx, course, req.params.userId, true);
      }),
  );

  app.get(
    "/me",
    {
      schema: {
        tags: ["Gradebook"],
        summary: "My course totals across all my courses",
        response: {
          200: z.array(
            z.object({
              course: z.object({ id: zId, fullname: z.string(), shortname: z.string() }),
              grade: z.number().nullable(),
              gradeMax: z.number().nullable(),
              percentage: z.number().nullable(),
            }),
          ),
        },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const me = requireUser(req);
        const mine = await tx
          .select({ course: courses })
          .from(enrolments)
          .innerJoin(courses, eq(courses.id, enrolments.courseId))
          .where(and(eq(enrolments.userId, me.id), eq(enrolments.status, "active")))
          .orderBy(asc(courses.fullname));
        const out = [];
        for (const { course } of mine) {
          if (!(await hasCapability(tx, req, "grades:view_own", course.contextId))) continue;
          if (!course.visible && !(await hasCapability(tx, req, "course:view_hidden", course.contextId))) continue;
          const [total] = await tx
            .select({ item: gradeItems, grade: gradeGrades.finalGrade })
            .from(gradeItems)
            .leftJoin(gradeGrades, and(eq(gradeGrades.itemId, gradeItems.id), eq(gradeGrades.userId, me.id)))
            .where(and(eq(gradeItems.courseId, course.id), eq(gradeItems.type, "course")))
            .limit(1);
          const shown = total && !total.item.hidden;
          const grade = shown ? (total.grade ?? null) : null;
          out.push({
            course: { id: course.id, fullname: course.fullname, shortname: course.shortname },
            grade,
            gradeMax: shown ? total.item.gradeMax : null,
            percentage: shown ? toPercent(grade, total.item.gradeMin, total.item.gradeMax) : null,
          });
        }
        return out;
      }),
  );

  app.get(
    "/courses/:courseId/export.csv",
    {
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        tags: ["Gradebook"],
        summary: "Export the gradebook as CSV",
        params: courseIdParam,
        response: { 200: z.string().describe("text/csv") },
      },
    },
    async (req, reply) => {
      const { course, csv } = await req.tenant(async (tx) => {
        const course = await loadCourseWith(tx, req, req.params.courseId, "grades:export");
        const [{ items }, learners] = await Promise.all([courseGradebook(tx, course.id), gradebookUsers(tx, course)]);
        const ordered = displayOrder(items);
        const grades =
          learners.length && items.length
            ? await tx
                .select({ itemId: gradeGrades.itemId, userId: gradeGrades.userId, finalGrade: gradeGrades.finalGrade })
                .from(gradeGrades)
                .where(and(inArray(gradeGrades.itemId, items.map((i) => i.id)), inArray(gradeGrades.userId, learners.map((u) => u.id))))
            : [];
        const gradeOf = new Map(grades.map((g) => [`${g.itemId}:${g.userId}`, g.finalGrade]));
        const rows: (string | number | null)[][] = [
          ["First name", "Last name", "Email", ...ordered.map((i) => `${i.name} (max ${formatGrade(i.gradeMax)})`)],
          ...learners.map((u) => [u.firstName, u.lastName, u.email, ...ordered.map((i) => formatGrade(gradeOf.get(`${i.id}:${u.id}`) ?? null))]),
        ];
        await audit(tx, req, "grades.exported", { type: "course", id: course.id }, { learners: learners.length });
        return { course, csv: toCsv(rows) };
      });
      const filename = `grades-${course.shortname.replace(/[^\w.-]+/g, "_")}-${new Date().toISOString().slice(0, 10)}.csv`;
      return reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`)
        .header("Cache-Control", "private, no-store")
        .header("X-Content-Type-Options", "nosniff")
        .send(`﻿${csv}`);
    },
  );

  // ─── Grades ─────────────────────────────────────────────────────────────

  app.put(
    "/items/:itemId/users/:userId",
    {
      schema: {
        tags: ["Gradebook"],
        summary: "Override (or release the override of) a learner's grade",
        params: itemUserParams,
        body: z.object({
          /** New final grade in the item's scale; ignored when `overridden` is false. */
          finalGrade: z.number().finite().nullable(),
          feedback: z.string().max(20_000).nullable().optional(),
          /** false = release the override and fall back to the activity's raw grade. */
          overridden: z.boolean().default(true),
        }),
        response: { 200: z.object({ grade: zGrade, courseTotal: z.number().nullable() }) },
      },
    },
    async (req) => {
      const me = requireUser(req);
      const result = await req.tenant(async (tx) => {
        const { item, course } = await loadGradeItem(tx, req, req.params.itemId, "grades:edit");
        const userId = req.params.userId;
        if (!(await isActiveParticipant(tx, course.id, userId))) throw notFound("User");
        if (item.locked) throw conflict("This grade item is locked");
        const body = req.body;
        if (body.overridden && body.finalGrade !== null && (body.finalGrade < item.gradeMin || body.finalGrade > item.gradeMax)) {
          throw badRequest(`Grade must be between ${item.gradeMin} and ${item.gradeMax}`);
        }

        const [existing] = await tx
          .select()
          .from(gradeGrades)
          .where(and(eq(gradeGrades.itemId, item.id), eq(gradeGrades.userId, userId)))
          .limit(1);
        const finalGrade = body.overridden ? body.finalGrade : (existing?.rawGrade ?? null);
        const feedback = body.feedback === undefined ? (existing?.feedback ?? null) : body.feedback ? cleanHtml(body.feedback) : null;
        const values = { finalGrade, feedback, overridden: body.overridden, gradedBy: me.id };
        const [row] = existing
          ? await tx.update(gradeGrades).set(values).where(eq(gradeGrades.id, existing.id)).returning()
          : await tx.insert(gradeGrades).values({ ...values, organizationId: req.org.id, itemId: item.id, userId, rawGrade: null }).returning();

        const oldGrade = existing?.finalGrade ?? null;
        if (oldGrade !== finalGrade) {
          await tx.insert(gradeHistory).values({
            organizationId: req.org.id,
            itemId: item.id,
            userId,
            oldGrade,
            newGrade: finalGrade,
            source: body.overridden ? "override" : "override_released",
            changedBy: me.id,
          });
        }
        await audit(tx, req, body.overridden ? "grade.overridden" : "grade.override_released", { type: "grade_item", id: item.id }, {
          userId,
          courseId: course.id,
          oldGrade,
          newGrade: finalGrade,
        });
        await recalculateCourseTotals(tx, { organizationId: req.org.id, courseId: course.id, userIds: [userId] });

        if (!item.hidden && oldGrade !== finalGrade) {
          await notify(tx, {
            organizationId: req.org.id,
            userIds: [userId],
            type: "grade_updated",
            title: `Your grade for "${item.name}" was updated`,
            body: `${course.fullname}: ${finalGrade === null ? "grade removed" : `${formatGrade(finalGrade)} / ${formatGrade(item.gradeMax)}`}`,
            link: `/courses/${course.id}/grades`,
          });
        }

        const total = await courseTotalItem(tx, course.id);
        const [totalGrade] = await tx
          .select({ g: gradeGrades.finalGrade })
          .from(gradeGrades)
          .where(and(eq(gradeGrades.itemId, total.id), eq(gradeGrades.userId, userId)))
          .limit(1);

        const event: EventMap["grade.updated"] | null =
          isLeafItem(item) && oldGrade !== finalGrade
            ? {
                organizationId: req.org.id,
                courseId: course.id,
                userId,
                itemId: item.id,
                activityId: item.activityId,
                finalGrade,
                gradeMax: item.gradeMax,
                gradePass: item.gradePass,
              }
            : null;
        return { grade: row!, courseTotal: totalGrade?.g ?? null, event };
      });
      // Only leaf items emit: totals are recalculated by the subscriber and never re-emit (no loop).
      if (result.event) await emit("grade.updated", result.event);
      return { grade: result.grade, courseTotal: result.courseTotal };
    },
  );

  app.get(
    "/items/:itemId/users/:userId/history",
    {
      schema: {
        tags: ["Gradebook"],
        summary: "Change history of one learner's grade",
        params: itemUserParams,
        response: {
          200: z.array(
            z.object({
              id: zId,
              oldGrade: z.number().nullable(),
              newGrade: z.number().nullable(),
              source: z.string(),
              changedAt: zDate,
              changedBy: zUserSummary.nullable(),
            }),
          ),
        },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const me = requireUser(req);
        const [row] = await tx
          .select({ item: gradeItems, course: courses })
          .from(gradeItems)
          .innerJoin(courses, eq(courses.id, gradeItems.courseId))
          .where(eq(gradeItems.id, req.params.itemId))
          .limit(1);
        if (!row) throw notFound("Grade item");
        const viewAll = await hasCapability(tx, req, "grades:view_all", row.course.contextId);
        const own =
          req.params.userId === me.id && !row.item.hidden && (await hasCapability(tx, req, "grades:view_own", row.course.contextId));
        // IDOR: learners only see their own history, and only for visible items.
        if (!viewAll && !own) throw notFound("Grade item");
        const changer = alias(users, "changer");
        const rows = await tx
          .select({ h: gradeHistory, u: { id: changer.id, firstName: changer.firstName, lastName: changer.lastName } })
          .from(gradeHistory)
          .leftJoin(changer, eq(changer.id, gradeHistory.changedBy))
          .where(and(eq(gradeHistory.itemId, row.item.id), eq(gradeHistory.userId, req.params.userId)))
          .orderBy(desc(gradeHistory.changedAt))
          .limit(200);
        return rows.map(({ h, u }) => ({
          id: h.id,
          oldGrade: h.oldGrade,
          newGrade: h.newGrade,
          source: h.source,
          changedAt: h.changedAt,
          changedBy: u?.id ? u : null,
        }));
      }),
  );

  // ─── Setup: items ───────────────────────────────────────────────────────

  app.get(
    "/courses/:courseId/setup",
    {
      schema: {
        tags: ["Gradebook"],
        summary: "Gradebook setup: categories and items",
        params: courseIdParam,
        response: { 200: z.object({ categories: z.array(zCategory), items: z.array(zItem) }) },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const course = await loadCourseWith(tx, req, req.params.courseId, "grades:edit");
        await rootCategory(tx, course);
        const { categories, items } = await courseGradebook(tx, course.id);
        return { categories: toCategories(categories, items), items: displayOrder(items).map(toItem) };
      }),
  );

  const zManualItemInput = z
    .object({
      name: z.string().trim().min(1).max(255),
      categoryId: zId.nullable().optional(),
      gradeMax: z.number().finite().positive().max(100_000).default(100),
      gradeMin: z.number().finite().min(0).default(0),
      gradePass: z.number().finite().min(0).nullable().optional(),
      weight: z.number().finite().min(0).max(1000).default(1),
      hidden: z.boolean().default(false),
      locked: z.boolean().default(false),
    })
    .refine((v) => v.gradeMin < v.gradeMax, { message: "gradeMin must be below gradeMax", path: ["gradeMin"] })
    .refine((v) => v.gradePass == null || (v.gradePass >= v.gradeMin && v.gradePass <= v.gradeMax), {
      message: "gradePass must be within the grade range",
      path: ["gradePass"],
    });

  app.post(
    "/courses/:courseId/items",
    {
      schema: { tags: ["Gradebook"], summary: "Add a manual grade item", params: courseIdParam, body: zManualItemInput, response: { 201: zItem } },
    },
    async (req, reply) => {
      const item = await req.tenant(async (tx) => {
        const course = await loadCourseWith(tx, req, req.params.courseId, "grades:edit");
        const root = await rootCategory(tx, course);
        const category = req.body.categoryId ? await categoryInCourse(tx, req.body.categoryId, course.id) : root;
        const [{ pos }] = (await tx
          .select({ pos: max(gradeItems.position) })
          .from(gradeItems)
          .where(and(eq(gradeItems.courseId, course.id), inArray(gradeItems.type, ["activity", "manual"])))) as [{ pos: number | null }];
        const [row] = await tx
          .insert(gradeItems)
          .values({
            ...req.body,
            gradePass: req.body.gradePass ?? null,
            organizationId: req.org.id,
            courseId: course.id,
            categoryId: category.id,
            type: "manual",
            position: (pos ?? -1) + 1,
          })
          .returning();
        await audit(tx, req, "grade_item.created", { type: "grade_item", id: row!.id }, { courseId: course.id, name: row!.name });
        return row!;
      });
      return reply.status(201).send(toItem(item));
    },
  );

  app.patch(
    "/items/:itemId",
    {
      schema: {
        tags: ["Gradebook"],
        summary: "Update a grade item (activity items: category, weight, hidden, locked only)",
        params: z.object({ itemId: zId }),
        body: z.object({
          name: z.string().trim().min(1).max(255).optional(),
          categoryId: zId.optional(),
          gradeMax: z.number().finite().positive().max(100_000).optional(),
          gradeMin: z.number().finite().min(0).optional(),
          gradePass: z.number().finite().min(0).nullable().optional(),
          weight: z.number().finite().min(0).max(1000).optional(),
          hidden: z.boolean().optional(),
          locked: z.boolean().optional(),
        }),
        response: { 200: zItem },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const { item, course } = await loadGradeItem(tx, req, req.params.itemId, "grades:edit");
        const allowed: Record<GradeItemRow["type"], string[]> = {
          manual: ["name", "categoryId", "gradeMax", "gradeMin", "gradePass", "weight", "hidden", "locked"],
          activity: ["categoryId", "weight", "hidden", "locked"],
          category: ["weight", "hidden", "locked"],
          course: ["hidden", "locked"],
        };
        const extra = Object.keys(req.body).filter((k) => req.body[k as keyof typeof req.body] !== undefined && !allowed[item.type].includes(k));
        if (extra.length) throw badRequest(`Cannot change ${extra.join(", ")} on a ${item.type} item`);
        if (req.body.categoryId) await categoryInCourse(tx, req.body.categoryId, course.id);
        const min = req.body.gradeMin ?? item.gradeMin;
        const maxG = req.body.gradeMax ?? item.gradeMax;
        const pass = req.body.gradePass !== undefined ? req.body.gradePass : item.gradePass;
        if (min >= maxG) throw badRequest("gradeMin must be below gradeMax");
        if (pass !== null && (pass < min || pass > maxG)) throw badRequest("gradePass must be within the grade range");

        const [row] = Object.keys(req.body).length
          ? await tx.update(gradeItems).set(req.body).where(eq(gradeItems.id, item.id)).returning()
          : [item];
        await audit(tx, req, "grade_item.updated", { type: "grade_item", id: item.id }, { courseId: course.id, changes: req.body });
        if (["categoryId", "gradeMax", "gradeMin", "weight"].some((k) => k in req.body)) {
          await recalculateCourseTotals(tx, { organizationId: req.org.id, courseId: course.id });
        }
        return toItem(row!);
      }),
  );

  app.delete(
    "/items/:itemId",
    { schema: { tags: ["Gradebook"], summary: "Delete a manual grade item and its grades", params: z.object({ itemId: zId }), response: { 200: zOk } } },
    async (req) => {
      await req.tenant(async (tx) => {
        const { item, course } = await loadGradeItem(tx, req, req.params.itemId, "grades:edit");
        if (item.type !== "manual") throw badRequest("Only manual grade items can be deleted here");
        await tx.delete(gradeItems).where(eq(gradeItems.id, item.id));
        await audit(tx, req, "grade_item.deleted", { type: "grade_item", id: item.id }, { courseId: course.id, name: item.name });
        await recalculateCourseTotals(tx, { organizationId: req.org.id, courseId: course.id });
      });
      return ok;
    },
  );

  app.put(
    "/courses/:courseId/items/order",
    {
      schema: {
        tags: ["Gradebook"],
        summary: "Reorder grade items",
        params: courseIdParam,
        body: z.object({ itemIds: z.array(zId).max(1000) }),
        response: { 200: zOk },
      },
    },
    async (req) => {
      await req.tenant(async (tx) => {
        const course = await loadCourseWith(tx, req, req.params.courseId, "grades:edit");
        for (const [position, id] of req.body.itemIds.entries()) {
          await tx
            .update(gradeItems)
            .set({ position })
            .where(and(eq(gradeItems.id, id), eq(gradeItems.courseId, course.id), inArray(gradeItems.type, ["activity", "manual"])));
        }
      });
      return ok;
    },
  );

  // ─── Setup: categories ──────────────────────────────────────────────────

  const zCategoryInput = z.object({
    name: z.string().trim().min(1).max(255),
    parentId: zId.nullable().optional(),
    aggregation: zAggregation.default("weighted_mean"),
    dropLowest: z.number().int().min(0).max(100).default(0),
    weight: z.number().finite().min(0).max(1000).default(1),
  });

  app.post(
    "/courses/:courseId/categories",
    { schema: { tags: ["Gradebook"], summary: "Add a grade category", params: courseIdParam, body: zCategoryInput, response: { 201: zCategory } } },
    async (req, reply) => {
      const out = await req.tenant(async (tx) => {
        const course = await loadCourseWith(tx, req, req.params.courseId, "grades:edit");
        const root = await rootCategory(tx, course);
        const parent = req.body.parentId ? await categoryInCourse(tx, req.body.parentId, course.id) : root;
        const [cat] = await tx
          .insert(gradeCategories)
          .values({
            organizationId: req.org.id,
            courseId: course.id,
            parentId: parent.id,
            name: req.body.name,
            aggregation: req.body.aggregation,
            dropLowest: req.body.dropLowest,
          })
          .returning();
        const item = await ensureCategoryItem(tx, cat!, req.body.weight);
        await audit(tx, req, "grade_category.created", { type: "grade_category", id: cat!.id }, { courseId: course.id, name: cat!.name });
        return toCategories([cat!], [item])[0]!;
      });
      return reply.status(201).send(out);
    },
  );

  app.patch(
    "/categories/:id",
    {
      schema: {
        tags: ["Gradebook"],
        summary: "Update a grade category (aggregation, drop lowest, parent, weight)",
        params: z.object({ id: zId }),
        body: patchSchema(zCategoryInput).extend({ parentId: zId.optional() }),
        response: { 200: zCategory },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const { category, course } = await loadGradeCategory(tx, req, req.params.id, "grades:edit");
        const { weight, parentId, ...fields } = req.body;
        const isRoot = category.parentId === null;
        if (isRoot && (weight !== undefined || parentId !== undefined)) throw badRequest("The course category has no parent or weight");
        if (parentId) {
          await categoryInCourse(tx, parentId, course.id);
          // Prevent cycles: the new parent may not be this category or one of its descendants.
          const { categories } = await courseGradebook(tx, course.id);
          const parentOf = new Map(categories.map((c) => [c.id, c.parentId]));
          for (let at: string | null | undefined = parentId; at; at = parentOf.get(at)) {
            if (at === category.id) throw badRequest("A category cannot be moved inside itself");
          }
        }
        const patch = { ...fields, ...(parentId ? { parentId } : {}) };
        const [row] = Object.keys(patch).length
          ? await tx.update(gradeCategories).set(patch).where(eq(gradeCategories.id, category.id)).returning()
          : [category];
        let item: GradeItemRow | null = null;
        if (!isRoot) {
          item = await ensureCategoryItem(tx, row!);
          if (weight !== undefined || fields.name) {
            const [updated] = await tx
              .update(gradeItems)
              .set({ ...(weight !== undefined ? { weight } : {}), ...(fields.name ? { name: `${fields.name} total` } : {}) })
              .where(eq(gradeItems.id, item.id))
              .returning();
            item = updated ?? item;
          }
        }
        await audit(tx, req, "grade_category.updated", { type: "grade_category", id: category.id }, { courseId: course.id, changes: req.body });
        await recalculateCourseTotals(tx, { organizationId: req.org.id, courseId: course.id });
        return toCategories([row!], item ? [item] : [])[0]!;
      }),
  );

  app.delete(
    "/categories/:id",
    {
      schema: {
        tags: ["Gradebook"],
        summary: "Delete a grade category (its items and subcategories move to the parent)",
        params: z.object({ id: zId }),
        response: { 200: zOk },
      },
    },
    async (req) => {
      await req.tenant(async (tx) => {
        const { category, course } = await loadGradeCategory(tx, req, req.params.id, "grades:edit");
        if (!category.parentId) throw badRequest("The course category cannot be deleted");
        await tx
          .update(gradeItems)
          .set({ categoryId: category.parentId })
          .where(and(eq(gradeItems.categoryId, category.id), inArray(gradeItems.type, ["activity", "manual"])));
        await tx.delete(gradeItems).where(and(eq(gradeItems.categoryId, category.id), eq(gradeItems.type, "category")));
        await tx.update(gradeCategories).set({ parentId: category.parentId }).where(eq(gradeCategories.parentId, category.id));
        await tx.delete(gradeCategories).where(eq(gradeCategories.id, category.id));
        await audit(tx, req, "grade_category.deleted", { type: "grade_category", id: category.id }, { courseId: course.id, name: category.name });
        await recalculateCourseTotals(tx, { organizationId: req.org.id, courseId: course.id });
      });
      return ok;
    },
  );
};
