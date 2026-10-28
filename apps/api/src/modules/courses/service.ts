import { and, asc, eq, max } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import {
  courseCategories,
  courseSections,
  courses,
  createContext,
  enrolments,
  getSystemContext,
  type DB,
} from "@lms/db";
import { requireUser } from "../../core/auth";
import { forbidden, must, notFound } from "../../core/errors";
import { assignRole, hasCapability, requireCapability, unassignRoles } from "../../core/rbac";
import { ensureCourseGradebook } from "../gradebook/service";

export type CourseRow = typeof courses.$inferSelect;

/**
 * Loads a course the current user may view. Hidden courses are only visible to
 * users with course:view_hidden. Missing access → 404 (don't reveal existence).
 */
export async function loadCourse(tx: DB, req: FastifyRequest, courseId: string) {
  const course = must((await tx.select().from(courses).where(eq(courses.id, courseId)).limit(1))[0], "Course");
  if (!(await hasCapability(tx, req, "course:view", course.contextId))) throw notFound("Course");
  if (!course.visible && !(await hasCapability(tx, req, "course:view_hidden", course.contextId))) throw notFound("Course");
  return course;
}

/** Loads a course and requires a capability in its context. */
export async function loadCourseWith(tx: DB, req: FastifyRequest, courseId: string, capability: Parameters<typeof requireCapability>[2]) {
  const course = must((await tx.select().from(courses).where(eq(courses.id, courseId)).limit(1))[0], "Course");
  await requireCapability(tx, req, capability, course.contextId);
  return course;
}

/** Context under which a new course is created: its category's, else the system context. */
async function parentContextFor(tx: DB, organizationId: string, categoryId: string | null | undefined) {
  if (categoryId) {
    const cat = must((await tx.select().from(courseCategories).where(eq(courseCategories.id, categoryId)).limit(1))[0], "Category");
    return cat.contextId;
  }
  return (await getSystemContext(tx, organizationId)).id;
}

export async function createCourse(
  tx: DB,
  req: FastifyRequest,
  input: Omit<typeof courses.$inferInsert, "id" | "organizationId" | "contextId" | "createdBy">,
) {
  const me = requireUser(req);
  const parentContextId = await parentContextFor(tx, req.org.id, input.categoryId);
  await requireCapability(tx, req, "course:create", parentContextId);

  const id = crypto.randomUUID();
  const ctx = await createContext(tx, { organizationId: req.org.id, level: "course", instanceId: id, parentId: parentContextId });
  const [course] = await tx
    .insert(courses)
    .values({ ...input, id, organizationId: req.org.id, contextId: ctx.id, createdBy: me.id })
    .returning();
  await tx.insert(courseSections).values({ organizationId: req.org.id, courseId: id, title: "General", position: 0 });
  await ensureCourseGradebook(tx, { organizationId: req.org.id, courseId: id });
  // The creator teaches the course (Moodle "creatornewroleid").
  await enrolUser(tx, { organizationId: req.org.id, course: course!, userId: me.id, method: "manual", role: "editing_teacher", assignedBy: me.id });
  return course!;
}

export const ENROLABLE_ROLES = ["student", "teacher", "editing_teacher", "guest"] as const;
export type EnrolRole = (typeof ENROLABLE_ROLES)[number];

/**
 * Enrols a user and assigns their course role (idempotent). Used by manual,
 * self, cohort and payment enrolment. Returns true when a new enrolment was created
 * so the caller can emit `user.enrolled` after commit.
 */
export async function enrolUser(
  tx: DB,
  input: {
    organizationId: string;
    course: CourseRow;
    userId: string;
    method: "manual" | "self" | "payment" | "cohort";
    role?: EnrolRole;
    timeEnd?: Date | null;
    cohortId?: string | null;
    assignedBy?: string | null;
  },
) {
  const [existing] = await tx
    .select()
    .from(enrolments)
    .where(and(eq(enrolments.courseId, input.course.id), eq(enrolments.userId, input.userId)))
    .limit(1);
  if (existing) {
    if (existing.status !== "active") {
      await tx.update(enrolments).set({ status: "active", timeEnd: input.timeEnd ?? null }).where(eq(enrolments.id, existing.id));
    }
  } else {
    await tx.insert(enrolments).values({
      organizationId: input.organizationId,
      courseId: input.course.id,
      userId: input.userId,
      method: input.method,
      timeStart: new Date(),
      timeEnd: input.timeEnd ?? null,
      cohortId: input.cohortId ?? null,
    });
  }
  await assignRole(tx, {
    organizationId: input.organizationId,
    userId: input.userId,
    shortname: input.role ?? "student",
    contextId: input.course.contextId,
    assignedBy: input.assignedBy,
  });
  return !existing;
}

export async function unenrolUser(tx: DB, course: CourseRow, userId: string) {
  await tx.delete(enrolments).where(and(eq(enrolments.courseId, course.id), eq(enrolments.userId, userId)));
  await unassignRoles(tx, userId, course.contextId);
}

export async function setEnrolmentStatus(tx: DB, course: CourseRow, userId: string, status: "active" | "suspended") {
  const [row] = await tx
    .update(enrolments)
    .set({ status })
    .where(and(eq(enrolments.courseId, course.id), eq(enrolments.userId, userId)))
    .returning();
  must(row, "Enrolment");
  // A suspended learner keeps their data but loses their course role (and so access).
  if (status === "suspended") await unassignRoles(tx, userId, course.contextId);
  else await assignRole(tx, { organizationId: course.organizationId, userId, shortname: "student", contextId: course.contextId });
}

export async function isEnrolled(tx: DB, courseId: string, userId: string) {
  const [row] = await tx
    .select({ status: enrolments.status })
    .from(enrolments)
    .where(and(eq(enrolments.courseId, courseId), eq(enrolments.userId, userId)))
    .limit(1);
  return row?.status === "active";
}

export async function sectionsOf(tx: DB, courseId: string) {
  return tx.select().from(courseSections).where(eq(courseSections.courseId, courseId)).orderBy(asc(courseSections.position));
}

export async function nextSectionPosition(tx: DB, courseId: string) {
  const [row] = await tx.select({ max: max(courseSections.position) }).from(courseSections).where(eq(courseSections.courseId, courseId));
  return (row?.max ?? -1) + 1;
}

export function assertSameCourse(a: { courseId: string }, courseId: string) {
  if (a.courseId !== courseId) throw forbidden();
}
