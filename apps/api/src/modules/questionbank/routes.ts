import { and, asc, count, desc, eq, ilike, inArray, isNull, type SQL } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { questionCategories, questions, questionVersions, users, type DB } from "@lms/db";
import { z } from "zod";
import { requireUser } from "../../core/auth";
import { audit } from "../../core/audit";
import { badRequest, forbidden, notFound } from "../../core/errors";
import { offset, ok, paged, zDate, zId, zOk, zPagination } from "../../core/schemas";
import { QUESTION_TYPES, zQuestionInput } from "../quiz/question-types";
import {
  assertCategoryDeletable,
  canManageCourseBank,
  canManageSharedBank,
  createQuestion,
  createVersion,
  latestVersion,
  latestVersionsOf,
  loadCategory,
  loadQuestion,
  versionOf,
} from "./service";

// ─── Schemas ────────────────────────────────────────────────────────────────

const zCategory = z.object({
  id: zId,
  courseId: zId.nullable(),
  parentId: zId.nullable(),
  name: z.string(),
  questionCount: z.number().int(),
  canEdit: z.boolean(),
});

const zQuestionSummary = z.object({
  id: zId,
  categoryId: zId,
  latestVersion: z.number().int(),
  type: z.enum(QUESTION_TYPES),
  name: z.string(),
  defaultMark: z.number(),
  createdAt: zDate,
  updatedAt: zDate,
});

/** Full authoring view (answers included) — only ever returned to question managers. */
const zQuestionVersion = z.object({
  id: zId,
  questionId: zId,
  version: z.number().int(),
  type: z.enum(QUESTION_TYPES),
  name: z.string(),
  text: z.string(),
  defaultMark: z.number(),
  data: z.record(z.unknown()),
  generalFeedback: z.string().nullable(),
  createdBy: z.object({ id: zId, firstName: z.string(), lastName: z.string() }).nullable(),
  createdAt: zDate,
});

const zQuestionDetail = z.object({
  id: zId,
  categoryId: zId,
  latestVersion: z.number().int(),
  current: zQuestionVersion,
});

const zExportQuestion = z.object({
  type: z.enum(QUESTION_TYPES),
  name: z.string(),
  text: z.string(),
  defaultMark: z.number(),
  generalFeedback: z.string().nullable().optional(),
  data: z.record(z.unknown()),
});
const zExport = z.object({ format: z.literal("lms-questions"), version: z.literal(1), category: z.string(), questions: z.array(zExportQuestion) });

const courseQuery = z.object({ courseId: zId.optional() });

export const routes: FastifyPluginAsyncZod = async (app) => {
  // ─── Categories ─────────────────────────────────────────────────────────

  app.get(
    "/permissions",
    {
      schema: {
        tags: ["Question bank"],
        summary: "Whether I can manage a course's bank and the organization-shared bank",
        querystring: courseQuery,
        response: { 200: z.object({ course: z.boolean(), shared: z.boolean() }) },
      },
    },
    async (req) => {
      requireUser(req);
      return req.tenant(async (tx) => ({
        course: req.query.courseId ? await canManageCourseBank(tx, req, req.query.courseId) : false,
        shared: await canManageSharedBank(tx, req),
      }));
    },
  );


  app.get(
    "/categories",
    {
      schema: {
        tags: ["Question bank"],
        summary: "Question categories of a course plus organization-shared categories",
        querystring: courseQuery,
        response: { 200: z.array(zCategory) },
      },
    },
    async (req) => {
      requireUser(req);
      return req.tenant(async (tx) => {
        const shared = await canManageSharedBank(tx, req);
        const courseOk = req.query.courseId ? await canManageCourseBank(tx, req, req.query.courseId) : false;
        if (req.query.courseId && !courseOk) throw notFound("Course");
        if (!req.query.courseId && !shared) throw forbidden();

        const courseCats = req.query.courseId
          ? await tx.select().from(questionCategories).where(eq(questionCategories.courseId, req.query.courseId)).orderBy(asc(questionCategories.name))
          : [];
        const sharedCats = await tx.select().from(questionCategories).where(isNull(questionCategories.courseId)).orderBy(asc(questionCategories.name));
        const all = [...courseCats, ...sharedCats];
        const counts = all.length
          ? await tx
              .select({ categoryId: questions.categoryId, n: count() })
              .from(questions)
              .where(
                and(
                  inArray(
                    questions.categoryId,
                    all.map((c) => c.id),
                  ),
                  isNull(questions.deletedAt),
                ),
              )
              .groupBy(questions.categoryId)
          : [];
        const countOf = new Map(counts.map((c) => [c.categoryId, Number(c.n)]));
        return all.map((c) => ({ ...c, questionCount: countOf.get(c.id) ?? 0, canEdit: c.courseId ? courseOk : shared }));
      });
    },
  );

  const zCategoryInput = z.object({
    courseId: zId.nullable(),
    parentId: zId.nullable().optional(),
    name: z.string().trim().min(1).max(255),
  });

  app.post(
    "/categories",
    {
      schema: {
        tags: ["Question bank"],
        summary: "Create a category (courseId null = shared across the organization)",
        body: zCategoryInput,
        response: { 201: zCategory },
      },
    },
    async (req, reply) => {
      requireUser(req);
      const row = await req.tenant(async (tx) => {
        const allowed = req.body.courseId ? await canManageCourseBank(tx, req, req.body.courseId) : await canManageSharedBank(tx, req);
        if (!allowed) throw forbidden();
        if (req.body.parentId) {
          const parent = await loadCategory(tx, req, req.body.parentId, "write");
          if (parent.courseId !== req.body.courseId) throw badRequest("Parent category belongs to another bank");
        }
        const [cat] = await tx
          .insert(questionCategories)
          .values({ organizationId: req.org.id, courseId: req.body.courseId, parentId: req.body.parentId ?? null, name: req.body.name })
          .returning();
        return cat!;
      });
      return reply.status(201).send({ ...row, questionCount: 0, canEdit: true });
    },
  );

  app.patch(
    "/categories/:id",
    {
      schema: {
        tags: ["Question bank"],
        summary: "Rename or move a category",
        params: z.object({ id: zId }),
        body: z.object({ name: z.string().trim().min(1).max(255).optional(), parentId: zId.nullable().optional() }),
        response: { 200: zOk },
      },
    },
    async (req) => {
      requireUser(req);
      await req.tenant(async (tx) => {
        const cat = await loadCategory(tx, req, req.params.id, "write");
        if (req.body.parentId) {
          if (req.body.parentId === cat.id) throw badRequest("A category cannot be its own parent");
          const parent = await loadCategory(tx, req, req.body.parentId, "write");
          if (parent.courseId !== cat.courseId) throw badRequest("Parent category belongs to another bank");
          // Prevent cycles: walk up from the new parent.
          let cursor: string | null = parent.parentId;
          for (let i = 0; cursor && i < 100; i++) {
            if (cursor === cat.id) throw badRequest("A category cannot be moved inside itself");
            const [up] = await tx.select({ parentId: questionCategories.parentId }).from(questionCategories).where(eq(questionCategories.id, cursor)).limit(1);
            cursor = up?.parentId ?? null;
          }
        }
        await tx.update(questionCategories).set(req.body).where(eq(questionCategories.id, cat.id));
      });
      return ok;
    },
  );

  app.delete(
    "/categories/:id",
    { schema: { tags: ["Question bank"], summary: "Delete an empty category", params: z.object({ id: zId }), response: { 200: zOk } } },
    async (req) => {
      requireUser(req);
      await req.tenant(async (tx) => {
        const cat = await loadCategory(tx, req, req.params.id, "write");
        await assertCategoryDeletable(tx, cat);
        await tx.delete(questionCategories).where(eq(questionCategories.id, cat.id));
        await audit(tx, req, "question_category.deleted", { type: "question_category", id: cat.id }, { name: cat.name });
      });
      return ok;
    },
  );

  // ─── Questions ──────────────────────────────────────────────────────────

  app.get(
    "/categories/:id/questions",
    {
      schema: {
        tags: ["Question bank"],
        summary: "List the questions of a category (latest versions)",
        params: z.object({ id: zId }),
        querystring: zPagination.extend({
          courseId: zId.optional(),
          search: z.string().trim().max(200).optional(),
          type: z.enum(QUESTION_TYPES).optional(),
        }),
        response: { 200: paged(zQuestionSummary) },
      },
    },
    async (req) => {
      requireUser(req);
      return req.tenant(async (tx) => {
        const cat = await loadCategory(tx, req, req.params.id, "read", req.query.courseId);
        // Filter on the latest version's name/type via a join on latestVersion.
        const conds: SQL[] = [eq(questions.categoryId, cat.id), isNull(questions.deletedAt), eq(questionVersions.version, questions.latestVersion)];
        if (req.query.search) conds.push(ilike(questionVersions.name, `%${req.query.search.replace(/[%_\\]/g, "\\$&")}%`));
        if (req.query.type) conds.push(eq(questionVersions.type, req.query.type));
        const where = and(...conds);
        const base = tx
          .select({ q: questions, v: questionVersions })
          .from(questions)
          .innerJoin(questionVersions, eq(questionVersions.questionId, questions.id));
        const [rows, [total]] = await Promise.all([
          base.where(where).orderBy(asc(questionVersions.name)).limit(req.query.pageSize).offset(offset(req.query)),
          tx.select({ n: count() }).from(questions).innerJoin(questionVersions, eq(questionVersions.questionId, questions.id)).where(where),
        ]);
        return {
          items: rows.map(({ q, v }) => ({
            id: q.id,
            categoryId: q.categoryId,
            latestVersion: q.latestVersion,
            type: v.type,
            name: v.name,
            defaultMark: v.defaultMark,
            createdAt: q.createdAt,
            updatedAt: v.createdAt,
          })),
          total: Number(total?.n ?? 0),
          page: req.query.page,
          pageSize: req.query.pageSize,
        };
      });
    },
  );

  async function withAuthor(tx: DB, v: typeof questionVersions.$inferSelect) {
    const [u] = v.createdBy
      ? await tx.select({ id: users.id, firstName: users.firstName, lastName: users.lastName }).from(users).where(eq(users.id, v.createdBy)).limit(1)
      : [];
    return { ...v, createdBy: u ?? null };
  }

  app.post(
    "/questions",
    {
      schema: {
        tags: ["Question bank"],
        summary: "Create a question (version 1)",
        body: zQuestionInput.and(z.object({ categoryId: zId })),
        response: { 201: zQuestionDetail },
      },
    },
    async (req, reply) => {
      const me = requireUser(req);
      const out = await req.tenant(async (tx) => {
        const cat = await loadCategory(tx, req, req.body.categoryId, "write");
        const { categoryId: _c, ...input } = req.body;
        const { question, version } = await createQuestion(tx, { organizationId: req.org.id, categoryId: cat.id, userId: me.id, question: input });
        return { ...question, current: await withAuthor(tx, version) };
      });
      return reply.status(201).send(out);
    },
  );

  app.get(
    "/questions/:id",
    {
      schema: {
        tags: ["Question bank"],
        summary: "Get a question with its latest version (authoring view)",
        params: z.object({ id: zId }),
        querystring: courseQuery,
        response: { 200: zQuestionDetail },
      },
    },
    async (req) => {
      requireUser(req);
      return req.tenant(async (tx) => {
        const { question } = await loadQuestion(tx, req, req.params.id, "read", req.query.courseId);
        return { ...question, current: await withAuthor(tx, await latestVersion(tx, question)) };
      });
    },
  );

  app.put(
    "/questions/:id",
    {
      schema: {
        tags: ["Question bank"],
        summary: "Edit a question: saves a new immutable version",
        params: z.object({ id: zId }),
        body: zQuestionInput,
        response: { 200: zQuestionDetail },
      },
    },
    async (req) => {
      const me = requireUser(req);
      return req.tenant(async (tx) => {
        const { question } = await loadQuestion(tx, req, req.params.id, "write");
        const version = await createVersion(tx, question, me.id, req.body);
        return { ...question, latestVersion: version.version, current: await withAuthor(tx, version) };
      });
    },
  );

  app.patch(
    "/questions/:id/category",
    {
      schema: {
        tags: ["Question bank"],
        summary: "Move a question to another category of the same bank",
        params: z.object({ id: zId }),
        body: z.object({ categoryId: zId }),
        response: { 200: zOk },
      },
    },
    async (req) => {
      requireUser(req);
      await req.tenant(async (tx) => {
        const { question, category } = await loadQuestion(tx, req, req.params.id, "write");
        const target = await loadCategory(tx, req, req.body.categoryId, "write");
        if (target.courseId !== category.courseId) throw badRequest("Questions can only move within the same bank");
        await tx.update(questions).set({ categoryId: target.id }).where(eq(questions.id, question.id));
      });
      return ok;
    },
  );

  app.delete(
    "/questions/:id",
    {
      schema: {
        tags: ["Question bank"],
        summary: "Delete a question (soft: quizzes and attempts that use it keep working)",
        params: z.object({ id: zId }),
        response: { 200: zOk },
      },
    },
    async (req) => {
      requireUser(req);
      await req.tenant(async (tx) => {
        const { question } = await loadQuestion(tx, req, req.params.id, "write");
        await tx.update(questions).set({ deletedAt: new Date() }).where(eq(questions.id, question.id));
        await audit(tx, req, "question.deleted", { type: "question", id: question.id });
      });
      return ok;
    },
  );

  app.get(
    "/questions/:id/versions",
    {
      schema: {
        tags: ["Question bank"],
        summary: "Version history of a question",
        params: z.object({ id: zId }),
        querystring: courseQuery,
        response: { 200: z.array(zQuestionVersion) },
      },
    },
    async (req) => {
      requireUser(req);
      return req.tenant(async (tx) => {
        const { question } = await loadQuestion(tx, req, req.params.id, "read", req.query.courseId);
        const rows = await tx.select().from(questionVersions).where(eq(questionVersions.questionId, question.id)).orderBy(desc(questionVersions.version));
        const authorIds = [...new Set(rows.map((r) => r.createdBy).filter((x): x is string => !!x))];
        const authors = authorIds.length
          ? await tx.select({ id: users.id, firstName: users.firstName, lastName: users.lastName }).from(users).where(inArray(users.id, authorIds))
          : [];
        const byId = new Map(authors.map((a) => [a.id, a]));
        return rows.map((r) => ({ ...r, createdBy: r.createdBy ? (byId.get(r.createdBy) ?? null) : null }));
      });
    },
  );

  app.get(
    "/questions/:id/versions/:version",
    {
      schema: {
        tags: ["Question bank"],
        summary: "One version of a question",
        params: z.object({ id: zId, version: z.coerce.number().int().min(1) }),
        querystring: courseQuery,
        response: { 200: zQuestionVersion },
      },
    },
    async (req) => {
      requireUser(req);
      return req.tenant(async (tx) => {
        const { question } = await loadQuestion(tx, req, req.params.id, "read", req.query.courseId);
        return withAuthor(tx, await versionOf(tx, question.id, req.params.version));
      });
    },
  );

  // ─── Import / export (JSON) ─────────────────────────────────────────────

  app.get(
    "/categories/:id/export",
    {
      schema: {
        tags: ["Question bank"],
        summary: "Export the latest versions of a category's questions as JSON",
        params: z.object({ id: zId }),
        querystring: courseQuery,
        response: { 200: zExport },
      },
    },
    async (req) => {
      requireUser(req);
      return req.tenant(async (tx) => {
        const cat = await loadCategory(tx, req, req.params.id, "read", req.query.courseId);
        const qs = await tx
          .select()
          .from(questions)
          .where(and(eq(questions.categoryId, cat.id), isNull(questions.deletedAt)));
        const latest = await latestVersionsOf(tx, qs);
        return {
          format: "lms-questions" as const,
          version: 1 as const,
          category: cat.name,
          questions: qs
            .map((q) => latest.get(q.id))
            .filter((v): v is NonNullable<typeof v> => !!v)
            .map((v) => ({ type: v.type, name: v.name, text: v.text, defaultMark: v.defaultMark, generalFeedback: v.generalFeedback, data: v.data })),
        };
      });
    },
  );

  app.post(
    "/categories/:id/import",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["Question bank"],
        summary: "Import questions (JSON export format). All-or-nothing: any invalid question rejects the import.",
        params: z.object({ id: zId }),
        body: z.object({ questions: z.array(z.unknown()).min(1).max(500) }),
        response: { 200: z.object({ imported: z.number().int() }) },
      },
    },
    async (req) => {
      const me = requireUser(req);
      const parsed = req.body.questions.map((q) => zQuestionInput.safeParse(q));
      const errors = parsed.flatMap((p, i) => (p.success ? [] : [{ index: i, issues: p.error.flatten() }]));
      if (errors.length) throw badRequest(`${errors.length} question(s) are invalid`, errors.slice(0, 20));
      return req.tenant(async (tx) => {
        const cat = await loadCategory(tx, req, req.params.id, "write");
        for (const p of parsed) {
          if (p.success) await createQuestion(tx, { organizationId: req.org.id, categoryId: cat.id, userId: me.id, question: p.data });
        }
        await audit(tx, req, "question.imported", { type: "question_category", id: cat.id }, { count: parsed.length });
        return { imported: parsed.length };
      });
    },
  );
};
