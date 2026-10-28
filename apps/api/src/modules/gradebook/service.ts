import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { Capability } from "@lms/rbac";
import {
  courses,
  enrolments,
  gradeCategories,
  gradeGrades,
  gradeHistory,
  gradeItems,
  roleAssignments,
  roles,
  users,
  type DB,
} from "@lms/db";
import type { ActivityRow } from "../../core/activity-types";
import { must, notFound } from "../../core/errors";
import type { EventMap } from "../../core/events";
import { hasCapability } from "../../core/rbac";
import { computeTotals, type Aggregation } from "./aggregate";

/**
 * Gradebook core API used by activity modules.
 *
 *   ensureCourseGradebook  – root category + course-total item (on course create)
 *   syncActivityGradeItem  – create/update the grade item of a gradable activity
 *   pushGrade              – activity reports a learner's raw grade
 *
 * pushGrade returns the `grade.updated` payload; the caller emits it after commit.
 */

export async function ensureCourseGradebook(tx: DB, input: { organizationId: string; courseId: string }) {
  const [root] = await tx
    .select()
    .from(gradeCategories)
    .where(and(eq(gradeCategories.courseId, input.courseId), isNull(gradeCategories.parentId)))
    .limit(1);
  if (root) return root;
  const [created] = await tx
    .insert(gradeCategories)
    .values({ organizationId: input.organizationId, courseId: input.courseId, name: "Course total", aggregation: "weighted_mean" })
    .returning();
  await tx.insert(gradeItems).values({
    organizationId: input.organizationId,
    courseId: input.courseId,
    categoryId: created!.id,
    type: "course",
    name: "Course total",
    gradeMax: 100,
    position: 10_000,
  });
  return created!;
}

export async function syncActivityGradeItem(
  tx: DB,
  activity: ActivityRow,
  grading: { gradeMax: number; gradePass: number | null },
) {
  const [existing] = await tx.select().from(gradeItems).where(eq(gradeItems.activityId, activity.id)).limit(1);
  if (existing) {
    const [updated] = await tx
      .update(gradeItems)
      .set({ name: activity.name, gradeMax: grading.gradeMax, gradePass: grading.gradePass, hidden: !activity.visible })
      .where(eq(gradeItems.id, existing.id))
      .returning();
    return updated!;
  }
  const root = await ensureCourseGradebook(tx, { organizationId: activity.organizationId, courseId: activity.courseId });
  const [created] = await tx
    .insert(gradeItems)
    .values({
      organizationId: activity.organizationId,
      courseId: activity.courseId,
      categoryId: root.id,
      type: "activity",
      activityId: activity.id,
      name: activity.name,
      gradeMax: grading.gradeMax,
      gradePass: grading.gradePass,
      hidden: !activity.visible,
      position: activity.position,
    })
    .returning();
  return created!;
}

export async function pushGrade(
  tx: DB,
  input: {
    organizationId: string;
    activityId: string;
    /** A specific grade item (e.g. an extra LTI line item) instead of the activity's own item. */
    itemId?: string;
    userId: string;
    /** In the activity's own scale (0..gradeMax). null clears the grade. */
    rawGrade: number | null;
    feedback?: string | null;
    gradedBy?: string | null;
    source: string;
  },
): Promise<EventMap["grade.updated"] | null> {
  const [item] = await tx
    .select()
    .from(gradeItems)
    .where(input.itemId ? eq(gradeItems.id, input.itemId) : eq(gradeItems.activityId, input.activityId))
    .limit(1);
  if (!item) return null;

  const raw = input.rawGrade === null ? null : Math.max(item.gradeMin, Math.min(item.gradeMax, input.rawGrade));
  const [existing] = await tx
    .select()
    .from(gradeGrades)
    .where(and(eq(gradeGrades.itemId, item.id), eq(gradeGrades.userId, input.userId)))
    .limit(1);

  // Locked items and teacher overrides keep their final grade; the raw grade is still recorded.
  const keepFinal = item.locked || existing?.overridden;
  const finalGrade = keepFinal ? (existing?.finalGrade ?? null) : raw;

  if (existing) {
    await tx
      .update(gradeGrades)
      .set({
        rawGrade: raw,
        finalGrade,
        feedback: input.feedback !== undefined ? input.feedback : existing.feedback,
        gradedBy: input.gradedBy ?? existing.gradedBy,
      })
      .where(eq(gradeGrades.id, existing.id));
  } else {
    await tx.insert(gradeGrades).values({
      organizationId: input.organizationId,
      itemId: item.id,
      userId: input.userId,
      rawGrade: raw,
      finalGrade,
      feedback: input.feedback ?? null,
      gradedBy: input.gradedBy ?? null,
    });
  }

  if ((existing?.finalGrade ?? null) !== finalGrade) {
    await tx.insert(gradeHistory).values({
      organizationId: input.organizationId,
      itemId: item.id,
      userId: input.userId,
      oldGrade: existing?.finalGrade ?? null,
      newGrade: finalGrade,
      source: input.source,
      changedBy: input.gradedBy ?? null,
    });
  }

  return {
    organizationId: input.organizationId,
    courseId: item.courseId,
    userId: input.userId,
    itemId: item.id,
    // Only the activity's own item counts for its completion rules.
    activityId: item.activityId,
    finalGrade,
    gradeMax: item.gradeMax,
    gradePass: item.gradePass,
  };
}

// ─── Gradebook setup & aggregation ──────────────────────────────────────────

export type GradeItemRow = typeof gradeItems.$inferSelect;
export type GradeCategoryRow = typeof gradeCategories.$inferSelect;

/** Items that hold learner grades directly (as opposed to computed totals). */
export const isLeafItem = (item: Pick<GradeItemRow, "type">) => item.type === "activity" || item.type === "manual";

export async function courseGradebook(tx: DB, courseId: string) {
  const [categories, items] = await Promise.all([
    tx.select().from(gradeCategories).where(eq(gradeCategories.courseId, courseId)).orderBy(asc(gradeCategories.createdAt)),
    tx.select().from(gradeItems).where(eq(gradeItems.courseId, courseId)).orderBy(asc(gradeItems.position), asc(gradeItems.createdAt)),
  ]);
  return { categories, items };
}

/** Grade item of a category (type "category", categoryId = the category it totals); created on demand. */
export async function ensureCategoryItem(tx: DB, category: GradeCategoryRow, weight = 1) {
  const [existing] = await tx
    .select()
    .from(gradeItems)
    .where(and(eq(gradeItems.categoryId, category.id), eq(gradeItems.type, "category")))
    .limit(1);
  if (existing) return existing;
  const [created] = await tx
    .insert(gradeItems)
    .values({
      organizationId: category.organizationId,
      courseId: category.courseId,
      categoryId: category.id,
      type: "category",
      name: `${category.name} total`,
      gradeMax: 100,
      weight,
      position: 9_000,
    })
    .returning();
  return created!;
}

/**
 * Learners shown in the gradebook: active enrolments holding the student role in the course.
 * Optional search on name/email.
 */
export async function gradebookUsers(tx: DB, course: { id: string; contextId: string }) {
  const rows = await tx
    .selectDistinct({ id: users.id, firstName: users.firstName, lastName: users.lastName, email: users.email })
    .from(enrolments)
    .innerJoin(users, eq(users.id, enrolments.userId))
    .innerJoin(roleAssignments, and(eq(roleAssignments.userId, enrolments.userId), eq(roleAssignments.contextId, course.contextId)))
    .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
    .where(and(eq(enrolments.courseId, course.id), eq(enrolments.status, "active"), eq(roles.archetype, "student"), isNull(users.deletedAt)));
  return rows.sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName));
}

/**
 * Recomputes category totals and the course total for some (default: all graded) learners of a course
 * and stores them as grade_grades rows of the category/course items.
 *
 * Overridden or locked total items keep their grade. Changes are written to grade_history with
 * source "aggregation". This never emits `grade.updated`: totals are derived data, and the
 * gradebook's own `grade.updated` subscriber calls this — emitting here would loop.
 */
export async function recalculateCourseTotals(tx: DB, input: { organizationId: string; courseId: string; userIds?: string[] }) {
  const { categories, items } = await courseGradebook(tx, input.courseId);
  if (!categories.length) return;
  const itemIds = items.map((i) => i.id);
  if (!itemIds.length) return;
  const totalItems = items.filter((i) => !isLeafItem(i));
  if (!totalItems.length || input.userIds?.length === 0) return;

  const grades = await tx
    .select()
    .from(gradeGrades)
    .where(and(inArray(gradeGrades.itemId, itemIds), input.userIds ? inArray(gradeGrades.userId, input.userIds) : undefined));
  const userIds = input.userIds ?? [...new Set(grades.map((g) => g.userId))];
  if (!userIds.length) return;

  const byUser = new Map<string, (typeof grades)[number][]>();
  for (const g of grades) byUser.set(g.userId, [...(byUser.get(g.userId) ?? []), g]);
  const totalIds = new Set(totalItems.map((i) => i.id));
  const tree = categories.map((c) => ({ id: c.id, parentId: c.parentId, aggregation: c.aggregation as Aggregation, dropLowest: c.dropLowest }));

  for (const userId of userIds) {
    const mine = byUser.get(userId) ?? [];
    const leafGrades = new Map<string, number | null>();
    const fixed = new Map<string, number | null>();
    const existingOf = new Map<string, (typeof grades)[number]>();
    for (const g of mine) {
      if (totalIds.has(g.itemId)) {
        existingOf.set(g.itemId, g);
        if (g.overridden) fixed.set(g.itemId, g.finalGrade);
      } else leafGrades.set(g.itemId, g.finalGrade);
    }
    for (const it of totalItems) if (it.locked && !fixed.has(it.id)) fixed.set(it.id, existingOf.get(it.id)?.finalGrade ?? null);

    const totals = computeTotals(tree, items, leafGrades, fixed);
    for (const [itemId, value] of totals) {
      const existing = existingOf.get(itemId);
      if (existing) {
        if (existing.finalGrade === value && existing.rawGrade === value) continue;
        await tx.update(gradeGrades).set({ rawGrade: value, finalGrade: value }).where(eq(gradeGrades.id, existing.id));
      } else {
        if (value === null) continue;
        await tx.insert(gradeGrades).values({ organizationId: input.organizationId, itemId, userId, rawGrade: value, finalGrade: value });
      }
      if ((existing?.finalGrade ?? null) !== value) {
        await tx.insert(gradeHistory).values({
          organizationId: input.organizationId,
          itemId,
          userId,
          oldGrade: existing?.finalGrade ?? null,
          newGrade: value,
          source: "aggregation",
        });
      }
    }
  }
}

/** Loads a grade item with its course and requires a capability in the course context (404 if absent). */
export async function loadGradeItem(tx: DB, req: FastifyRequest, itemId: string, capability: Capability) {
  const [row] = await tx
    .select({ item: gradeItems, course: courses })
    .from(gradeItems)
    .innerJoin(courses, eq(courses.id, gradeItems.courseId))
    .where(eq(gradeItems.id, itemId))
    .limit(1);
  if (!row) throw notFound("Grade item");
  if (!(await hasCapability(tx, req, capability, row.course.contextId))) throw notFound("Grade item");
  return row;
}

export async function loadGradeCategory(tx: DB, req: FastifyRequest, categoryId: string, capability: Capability) {
  const [row] = await tx
    .select({ category: gradeCategories, course: courses })
    .from(gradeCategories)
    .innerJoin(courses, eq(courses.id, gradeCategories.courseId))
    .where(eq(gradeCategories.id, categoryId))
    .limit(1);
  if (!row) throw notFound("Grade category");
  if (!(await hasCapability(tx, req, capability, row.course.contextId))) throw notFound("Grade category");
  return row;
}

/** Root category of a course (creating the gradebook if needed). */
export async function rootCategory(tx: DB, course: { id: string; organizationId: string }) {
  return ensureCourseGradebook(tx, { organizationId: course.organizationId, courseId: course.id });
}

export async function courseTotalItem(tx: DB, courseId: string) {
  return must(
    (await tx.select().from(gradeItems).where(and(eq(gradeItems.courseId, courseId), eq(gradeItems.type, "course"))).limit(1))[0],
    "Course total",
  );
}
