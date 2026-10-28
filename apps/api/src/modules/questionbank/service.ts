import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { attemptAnswers, courses, getSystemContext, questionCategories, questions, questionVersions, quizSlots, type DB } from "@lms/db";
import { conflict, must, notFound } from "../../core/errors";
import { hasCapability } from "../../core/rbac";
import { cleanHtml } from "../../core/sanitize";
import type { QuestionInput } from "../quiz/question-types";

export type CategoryRow = typeof questionCategories.$inferSelect;
export type QuestionRow = typeof questions.$inferSelect;
export type QuestionVersionRow = typeof questionVersions.$inferSelect;

/**
 * Who may use a question category:
 *  - course category → question:manage in that course
 *  - shared category (courseId null) → question:manage at system level to write;
 *    reading is also allowed from a course where the user has question:manage
 *    (so teachers can add shared questions to their quizzes).
 */
export async function canManageCourseBank(tx: DB, req: FastifyRequest, courseId: string) {
  const [course] = await tx.select({ contextId: courses.contextId }).from(courses).where(eq(courses.id, courseId)).limit(1);
  if (!course) return false;
  return hasCapability(tx, req, "question:manage", course.contextId);
}

export async function canManageSharedBank(tx: DB, req: FastifyRequest) {
  const system = await getSystemContext(tx, req.org.id);
  return hasCapability(tx, req, "question:manage", system.id);
}

export async function loadCategory(tx: DB, req: FastifyRequest, categoryId: string, mode: "read" | "write", fromCourseId?: string | null) {
  const cat = must((await tx.select().from(questionCategories).where(eq(questionCategories.id, categoryId)).limit(1))[0], "Category");
  if (cat.courseId) {
    if (!(await canManageCourseBank(tx, req, cat.courseId))) throw notFound("Category");
  } else if (!(await canManageSharedBank(tx, req))) {
    const readable = mode === "read" && fromCourseId && (await canManageCourseBank(tx, req, fromCourseId));
    if (!readable) throw notFound("Category");
  }
  return cat;
}

/** Loads a (non-deleted) question and checks access through its category. */
export async function loadQuestion(tx: DB, req: FastifyRequest, questionId: string, mode: "read" | "write", fromCourseId?: string | null) {
  const q = must(
    (
      await tx
        .select()
        .from(questions)
        .where(and(eq(questions.id, questionId), isNull(questions.deletedAt)))
        .limit(1)
    )[0],
    "Question",
  );
  const category = await loadCategory(tx, req, q.categoryId, mode, fromCourseId);
  return { question: q, category };
}

export async function latestVersion(tx: DB, q: QuestionRow) {
  return must(
    (
      await tx
        .select()
        .from(questionVersions)
        .where(and(eq(questionVersions.questionId, q.id), eq(questionVersions.version, q.latestVersion)))
        .limit(1)
    )[0],
    "Question version",
  );
}

export async function versionOf(tx: DB, questionId: string, version: number) {
  return must(
    (
      await tx
        .select()
        .from(questionVersions)
        .where(and(eq(questionVersions.questionId, questionId), eq(questionVersions.version, version)))
        .limit(1)
    )[0],
    "Question version",
  );
}

function versionValues(input: QuestionInput) {
  return {
    type: input.type,
    name: input.name,
    text: cleanHtml(input.text),
    defaultMark: input.defaultMark,
    data: input.data as Record<string, unknown>,
    generalFeedback: input.generalFeedback ? cleanHtml(input.generalFeedback) : null,
  };
}

export async function createQuestion(tx: DB, input: { organizationId: string; categoryId: string; userId: string; question: QuestionInput }) {
  const [q] = await tx
    .insert(questions)
    .values({ organizationId: input.organizationId, categoryId: input.categoryId, latestVersion: 1, createdBy: input.userId })
    .returning();
  const [v] = await tx
    .insert(questionVersions)
    .values({ organizationId: input.organizationId, questionId: q!.id, version: 1, createdBy: input.userId, ...versionValues(input.question) })
    .returning();
  return { question: q!, version: v! };
}

/** Every edit creates a new immutable version; attempts keep referencing the version they used. */
export async function createVersion(tx: DB, q: QuestionRow, userId: string, input: QuestionInput) {
  // Re-read latestVersion under a row lock so concurrent edits get distinct numbers.
  const [locked] = await tx.select().from(questions).where(eq(questions.id, q.id)).for("update").limit(1);
  const next = (locked?.latestVersion ?? q.latestVersion) + 1;
  const [v] = await tx
    .insert(questionVersions)
    .values({ organizationId: q.organizationId, questionId: q.id, version: next, createdBy: userId, ...versionValues(input) })
    .returning();
  await tx.update(questions).set({ latestVersion: next }).where(eq(questions.id, q.id));
  return v!;
}

/** Latest versions for many questions at once. */
export async function latestVersionsOf(tx: DB, qs: QuestionRow[]) {
  if (!qs.length) return new Map<string, QuestionVersionRow>();
  const rows = await tx
    .select()
    .from(questionVersions)
    .where(
      inArray(
        questionVersions.questionId,
        qs.map((q) => q.id),
      ),
    )
    .orderBy(desc(questionVersions.version));
  const want = new Map(qs.map((q) => [q.id, q.latestVersion]));
  const out = new Map<string, QuestionVersionRow>();
  for (const r of rows) if (want.get(r.questionId) === r.version) out.set(r.questionId, r);
  return out;
}

/** Throws 409 when a category still has live questions or sub-categories, or its questions are used by quizzes. */
export async function assertCategoryDeletable(tx: DB, cat: CategoryRow) {
  const [child] = await tx.select({ id: questionCategories.id }).from(questionCategories).where(eq(questionCategories.parentId, cat.id)).limit(1);
  if (child) throw conflict("Delete or move the sub-categories first");
  const qs = await tx.select({ id: questions.id, deletedAt: questions.deletedAt }).from(questions).where(eq(questions.categoryId, cat.id));
  if (qs.some((q) => !q.deletedAt)) throw conflict("Delete the questions in this category first");
  if (qs.length) {
    const ids = qs.map((q) => q.id);
    const [slot] = await tx.select({ id: quizSlots.id }).from(quizSlots).where(inArray(quizSlots.questionId, ids)).limit(1);
    if (slot) throw conflict("Questions in this category are still used by quizzes");
    const [used] = await tx
      .select({ id: attemptAnswers.id })
      .from(attemptAnswers)
      .innerJoin(questionVersions, eq(questionVersions.id, attemptAnswers.questionVersionId))
      .where(inArray(questionVersions.questionId, ids))
      .limit(1);
    if (used) throw conflict("Questions in this category have quiz attempts");
  }
}
