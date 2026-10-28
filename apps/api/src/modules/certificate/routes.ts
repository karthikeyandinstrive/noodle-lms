import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import {
  activities,
  certificateActivities,
  certificateTemplates,
  courses,
  enrolments,
  files,
  getSystemContext,
  issuedCertificates,
  roleAssignments,
  roles,
  users,
  type DB,
} from "@lms/db";
import { z } from "zod";
import { audit } from "../../core/audit";
import { requireUser } from "../../core/auth";
import { badRequest, conflict, forbidden, must, notFound } from "../../core/errors";
import { emitInTx } from "../../core/events";
import { downloadUrl } from "../../core/files";
import { hasCapability, requireCapability } from "../../core/rbac";
import { ok, zDate, zId, zNullableDate, zOk, zUserSummary, patchSchema } from "../../core/schemas";
import { loadActivity } from "../activities/service";
import { isEnrolled } from "../courses/service";
import { CERTIFICATE_FONTS, certificateFont } from "./pdf";
import {
  attachTemplateFiles,
  certActivityOf,
  certificateStatus,
  checkEligibility,
  issueCertificate,
  renderTemplate,
  SAMPLE_VALUES,
  zTemplateInput,
  type IssuedRow,
} from "./service";

const zTemplate = z.object({
  id: zId,
  name: z.string(),
  orientation: z.enum(["landscape", "portrait"]),
  backgroundFileId: zId.nullable(),
  elements: z.array(z.record(z.string(), z.unknown())),
  createdAt: zDate,
});

const zStatus = z.enum(["valid", "revoked", "expired"]);

const zIssued = z.object({
  id: zId,
  code: z.string(),
  issuedAt: zDate,
  expiresAt: zNullableDate,
  revokedAt: zNullableDate,
  status: zStatus,
  hasFile: z.boolean(),
});

const toTemplate = (t: typeof certificateTemplates.$inferSelect) => ({
  ...t,
  orientation: (t.orientation === "portrait" ? "portrait" : "landscape") as "landscape" | "portrait",
  elements: t.elements as unknown as Record<string, unknown>[],
});

const toIssued = (r: IssuedRow) => ({ ...r, status: certificateStatus(r), hasFile: !!r.fileId });

const activityParam = z.object({ activityId: zId });

async function systemCtx(tx: DB, orgId: string) {
  return (await getSystemContext(tx, orgId)).id;
}

/** Active learners (student role in the course context) with an active enrolment. */
async function learnersOf(tx: DB, course: { id: string; contextId: string }) {
  return tx
    .selectDistinct({ id: users.id, firstName: users.firstName, lastName: users.lastName, email: users.email })
    .from(enrolments)
    .innerJoin(users, eq(users.id, enrolments.userId))
    .innerJoin(roleAssignments, and(eq(roleAssignments.userId, enrolments.userId), eq(roleAssignments.contextId, course.contextId)))
    .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
    .where(and(eq(enrolments.courseId, course.id), eq(enrolments.status, "active"), eq(roles.archetype, "student")))
    .orderBy(asc(users.lastName), asc(users.firstName));
}

export const routes: FastifyPluginAsyncZod = async (app) => {
  // ─── Templates (certificate:manage_templates at system level) ──────────

  app.get(
    "/templates",
    { schema: { tags: ["Certificates"], summary: "List certificate templates", response: { 200: z.array(zTemplate) } } },
    (req) =>
      req.tenant(async (tx) => {
        requireUser(req);
        await requireCapability(tx, req, "certificate:manage_templates", await systemCtx(tx, req.org.id));
        return (await tx.select().from(certificateTemplates).orderBy(asc(certificateTemplates.name))).map(toTemplate);
      }),
  );

  app.get(
    "/templates/options",
    {
      schema: {
        tags: ["Certificates"],
        summary: "Template names for the certificate activity settings form (course editors)",
        response: { 200: z.array(z.object({ id: zId, name: z.string(), orientation: z.string() })) },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        requireUser(req);
        return tx
          .select({ id: certificateTemplates.id, name: certificateTemplates.name, orientation: certificateTemplates.orientation })
          .from(certificateTemplates)
          .orderBy(asc(certificateTemplates.name));
      }),
  );

  app.post(
    "/templates",
    { schema: { tags: ["Certificates"], summary: "Create a certificate template", body: zTemplateInput, response: { 201: zTemplate } } },
    async (req, reply) => {
      const me = requireUser(req);
      const row = await req.tenant(async (tx) => {
        const ctx = await systemCtx(tx, req.org.id);
        await requireCapability(tx, req, "certificate:manage_templates", ctx);
        const id = crypto.randomUUID();
        await attachTemplateFiles(tx, { ...req.body, userId: me.id, templateId: id, systemContextId: ctx });
        const [t] = await tx
          .insert(certificateTemplates)
          .values({ id, organizationId: req.org.id, name: req.body.name, orientation: req.body.orientation, backgroundFileId: req.body.backgroundFileId ?? null, elements: req.body.elements })
          .returning();
        await audit(tx, req, "certificate_template.created", { type: "certificate_template", id });
        return t!;
      });
      return reply.status(201).send(toTemplate(row));
    },
  );

  app.get(
    "/templates/:id",
    { schema: { tags: ["Certificates"], summary: "Get a certificate template", params: z.object({ id: zId }), response: { 200: zTemplate } } },
    (req) =>
      req.tenant(async (tx) => {
        requireUser(req);
        await requireCapability(tx, req, "certificate:manage_templates", await systemCtx(tx, req.org.id));
        return toTemplate(must((await tx.select().from(certificateTemplates).where(eq(certificateTemplates.id, req.params.id)).limit(1))[0], "Template"));
      }),
  );

  app.patch(
    "/templates/:id",
    {
      schema: { tags: ["Certificates"], summary: "Update a certificate template", params: z.object({ id: zId }), body: patchSchema(zTemplateInput), response: { 200: zTemplate } },
    },
    (req) =>
      req.tenant(async (tx) => {
        const me = requireUser(req);
        const ctx = await systemCtx(tx, req.org.id);
        await requireCapability(tx, req, "certificate:manage_templates", ctx);
        const t = must((await tx.select().from(certificateTemplates).where(eq(certificateTemplates.id, req.params.id)).limit(1))[0], "Template");
        const next = {
          backgroundFileId: req.body.backgroundFileId !== undefined ? req.body.backgroundFileId : t.backgroundFileId,
          elements: req.body.elements ?? t.elements,
        };
        await attachTemplateFiles(tx, { ...next, userId: me.id, templateId: t.id, systemContextId: ctx });
        const [row] = await tx
          .update(certificateTemplates)
          .set({ ...(req.body.name ? { name: req.body.name } : {}), ...(req.body.orientation ? { orientation: req.body.orientation } : {}), ...next })
          .where(eq(certificateTemplates.id, t.id))
          .returning();
        await audit(tx, req, "certificate_template.updated", { type: "certificate_template", id: t.id });
        return toTemplate(row!);
      }),
  );

  app.delete(
    "/templates/:id",
    { schema: { tags: ["Certificates"], summary: "Delete an unused certificate template", params: z.object({ id: zId }), response: { 200: zOk } } },
    async (req) => {
      await req.tenant(async (tx) => {
        requireUser(req);
        await requireCapability(tx, req, "certificate:manage_templates", await systemCtx(tx, req.org.id));
        const t = must((await tx.select().from(certificateTemplates).where(eq(certificateTemplates.id, req.params.id)).limit(1))[0], "Template");
        const [used] = await tx.select({ id: certificateActivities.id }).from(certificateActivities).where(eq(certificateActivities.templateId, t.id)).limit(1);
        if (used) throw conflict("This template is used by certificate activities");
        await tx.delete(certificateTemplates).where(eq(certificateTemplates.id, t.id));
        await audit(tx, req, "certificate_template.deleted", { type: "certificate_template", id: t.id }, { name: t.name });
      });
      return ok;
    },
  );

  app.post(
    "/templates/preview",
    {
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: { tags: ["Certificates"], summary: "Render an (unsaved) template with sample values as PDF", body: zTemplateInput.omit({ name: true }) },
    },
    async (req, reply) => {
      const me = requireUser(req);
      const pdf = await req.tenant(async (tx) => {
        await requireCapability(tx, req, "certificate:manage_templates", await systemCtx(tx, req.org.id));
        return renderTemplate(tx, req.org.id, { ...req.body, backgroundFileId: req.body.backgroundFileId ?? null }, { ...SAMPLE_VALUES, orgname: req.org.name }, {
          previewUserId: me.id,
          title: "Certificate preview",
        });
      });
      return reply
        .header("Cache-Control", "no-store")
        .header("Content-Disposition", 'inline; filename="certificate-preview.pdf"')
        .type("application/pdf")
        .send(pdf);
    },
  );

  app.get(
    "/fonts/:file",
    {
      config: { tenant: false, rateLimit: { max: 120, timeWindow: "1 minute" } },
      schema: {
        tags: ["Certificates"],
        summary: "The fonts certificates are rendered with (DejaVu Sans), for the template designer preview",
        params: z.object({ file: z.enum([CERTIFICATE_FONTS.regular, CERTIFICATE_FONTS.bold]) }),
      },
    },
    async (req, reply) => {
      const bytes = await certificateFont(req.params.file);
      return reply
        .header("Cache-Control", "public, max-age=31536000, immutable")
        .header("Cross-Origin-Resource-Policy", "same-site")
        .type("font/ttf")
        .send(Buffer.from(bytes));
    },
  );

  // ─── My certificates & public verification ─────────────────────────────

  app.get(
    "/me",
    {
      schema: {
        tags: ["Certificates"],
        summary: "All my certificates",
        response: { 200: z.array(zIssued.extend({ activityId: zId, activityName: z.string(), courseId: zId, courseName: z.string() })) },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const me = requireUser(req);
        const rows = await tx
          .select({ issued: issuedCertificates, activityId: activities.id, activityName: activities.name, courseName: courses.fullname })
          .from(issuedCertificates)
          .innerJoin(certificateActivities, eq(certificateActivities.id, issuedCertificates.certificateActivityId))
          .innerJoin(activities, eq(activities.id, certificateActivities.activityId))
          .innerJoin(courses, eq(courses.id, issuedCertificates.courseId))
          .where(eq(issuedCertificates.userId, me.id))
          .orderBy(desc(issuedCertificates.issuedAt));
        return rows.map((r) => ({ ...toIssued(r.issued), activityId: r.activityId, activityName: r.activityName, courseName: r.courseName }));
      }),
  );

  app.get(
    "/verify/:code",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["Certificates"],
        summary: "Public certificate verification (anonymous; per organization host)",
        params: z.object({ code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/) }),
        response: {
          200: z.object({
            code: z.string(),
            status: zStatus,
            recipientName: z.string(),
            courseName: z.string(),
            certificateName: z.string(),
            organizationName: z.string(),
            issuedAt: zDate,
            expiresAt: zNullableDate,
            revokedAt: zNullableDate,
          }),
        },
      },
    },
    async (req, reply) => {
      reply.header("Cache-Control", "no-store");
      return req.tenant(async (tx) => {
        const [row] = await tx
          .select({ issued: issuedCertificates, activityName: activities.name })
          .from(issuedCertificates)
          .innerJoin(certificateActivities, eq(certificateActivities.id, issuedCertificates.certificateActivityId))
          .innerJoin(activities, eq(activities.id, certificateActivities.activityId))
          .where(eq(issuedCertificates.code, req.params.code))
          .limit(1);
        if (!row) throw notFound("Certificate");
        const s = row.issued.snapshot;
        return {
          code: row.issued.code,
          status: certificateStatus(row.issued),
          recipientName: s.fullname ?? "",
          courseName: s.coursename ?? "",
          certificateName: row.activityName,
          organizationName: s.orgname || req.org.name,
          issuedAt: row.issued.issuedAt,
          expiresAt: row.issued.expiresAt,
          revokedAt: row.issued.revokedAt,
        };
      });
    },
  );

  // ─── Per activity ──────────────────────────────────────────────────────

  app.get(
    "/:activityId/status",
    {
      schema: {
        tags: ["Certificates"],
        summary: "My eligibility and certificate for this activity",
        params: activityParam,
        response: {
          200: z.object({
            certificate: zIssued.nullable(),
            eligible: z.boolean(),
            courseCompleted: z.boolean(),
            gradePercent: z.number().nullable(),
            reasons: z.array(z.string()),
            enrolled: z.boolean(),
          }),
        },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const me = requireUser(req);
        const { activity, course } = await loadActivity(tx, req, req.params.activityId, { type: "certificate" });
        const cert = must(await certActivityOf(tx, activity.id), "Certificate");
        const [mine] = await tx
          .select()
          .from(issuedCertificates)
          .where(and(eq(issuedCertificates.certificateActivityId, cert.id), eq(issuedCertificates.userId, me.id)))
          .limit(1);
        const elig = await checkEligibility(tx, cert, course.id, me.id);
        return { certificate: mine ? toIssued(mine) : null, ...elig, enrolled: await isEnrolled(tx, course.id, me.id) };
      }),
  );

  app.post(
    "/:activityId/issue",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: { tags: ["Certificates"], summary: "Claim my certificate (when eligible)", params: activityParam, body: z.object({}).optional(), response: { 200: zIssued } },
    },
    async (req) => {
      const me = requireUser(req);
      const out = await req.tenant(async (tx) => {
        const { activity, course } = await loadActivity(tx, req, req.params.activityId, { type: "certificate" });
        if (!(await isEnrolled(tx, course.id, me.id))) throw forbidden("Only enrolled learners can claim this certificate");
        const cert = must(await certActivityOf(tx, activity.id), "Certificate");
        const [existing] = await tx
          .select()
          .from(issuedCertificates)
          .where(and(eq(issuedCertificates.certificateActivityId, cert.id), eq(issuedCertificates.userId, me.id)))
          .limit(1);
        if (existing) {
          if (existing.revokedAt) throw forbidden("This certificate was revoked. Contact your teacher.");
          return { row: existing };
        }
        const elig = await checkEligibility(tx, cert, course.id, me.id);
        if (!elig.eligible) throw badRequest(elig.reasons.join(" ") || "You are not eligible yet");
        const row = await issueCertificate(tx, { activity, cert, userId: me.id, organizationName: req.org.name });
        if (!row) {
          // Issued concurrently (e.g. by the auto-issue job): return that one.
          const [now] = await tx
            .select()
            .from(issuedCertificates)
            .where(and(eq(issuedCertificates.certificateActivityId, cert.id), eq(issuedCertificates.userId, me.id)))
            .limit(1);
          return { row: must(now, "Certificate") };
        }
        await emitInTx(tx, "certificate.issued", {
          organizationId: req.org.id,
          courseId: activity.courseId,
          activityId: activity.id,
          userId: me.id,
          issuedCertificateId: row.id,
        });
        return { row };
      });
      return toIssued(out.row);
    },
  );

  app.post(
    "/:activityId/issue/:userId",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        tags: ["Certificates"],
        summary: "Manually issue (or reinstate) a certificate for a learner (certificate:issue)",
        params: activityParam.extend({ userId: zId }),
        body: z.object({}).optional(),
        response: { 200: zIssued },
      },
    },
    async (req) => {
      requireUser(req);
      const out = await req.tenant(async (tx) => {
        const { activity, course } = await loadActivity(tx, req, req.params.activityId, { type: "certificate", capability: "certificate:issue" });
        if (!(await isEnrolled(tx, course.id, req.params.userId))) throw badRequest("The user is not enrolled in this course");
        const cert = must(await certActivityOf(tx, activity.id), "Certificate");
        const row = await issueCertificate(tx, { activity, cert, userId: req.params.userId, organizationName: req.org.name, reinstate: true });
        if (!row) throw conflict("A certificate was already issued to this user");
        await audit(tx, req, "certificate.issued_manually", { type: "issued_certificate", id: row.id }, { userId: req.params.userId, activityId: activity.id });
        await emitInTx(tx, "certificate.issued", {
          organizationId: req.org.id,
          courseId: activity.courseId,
          activityId: activity.id,
          userId: req.params.userId,
          issuedCertificateId: row.id,
        });
        return row;
      });
      return toIssued(out);
    },
  );

  app.get(
    "/:activityId/issued",
    {
      schema: {
        tags: ["Certificates"],
        summary: "Learners and their certificates for this activity (certificate:view_issued)",
        params: activityParam,
        response: { 200: z.array(z.object({ user: zUserSummary, certificate: zIssued.nullable() })) },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const { activity, course } = await loadActivity(tx, req, req.params.activityId, { type: "certificate", capability: "certificate:view_issued" });
        const cert = must(await certActivityOf(tx, activity.id), "Certificate");
        const issued = await tx.select().from(issuedCertificates).where(eq(issuedCertificates.certificateActivityId, cert.id));
        const learners = await learnersOf(tx, course);
        const byUser = new Map(issued.map((i) => [i.userId, i]));
        const known = new Set(learners.map((l) => l.id));
        // Include certificates of users who are no longer learners in the course.
        const others = issued.filter((i) => !known.has(i.userId)).map((i) => i.userId);
        const extra = others.length
          ? await tx.select({ id: users.id, firstName: users.firstName, lastName: users.lastName, email: users.email }).from(users).where(inArray(users.id, others))
          : [];
        return [...learners, ...extra].map((u) => {
          const c = byUser.get(u.id);
          return { user: u, certificate: c ? toIssued(c) : null };
        });
      }),
  );

  app.get(
    "/issued/:id/download",
    {
      schema: {
        tags: ["Certificates"],
        summary: "Download an issued certificate PDF (own, or certificate:view_issued)",
        params: z.object({ id: zId }),
        querystring: z.object({ inline: z.coerce.boolean().default(false) }),
      },
    },
    async (req, reply) => {
      const me = requireUser(req);
      const url = await req.tenant(async (tx) => {
        const [row] = await tx
          .select({ issued: issuedCertificates, contextId: activities.contextId })
          .from(issuedCertificates)
          .innerJoin(certificateActivities, eq(certificateActivities.id, issuedCertificates.certificateActivityId))
          .innerJoin(activities, eq(activities.id, certificateActivities.activityId))
          .where(eq(issuedCertificates.id, req.params.id))
          .limit(1);
        if (!row) throw notFound("Certificate");
        const staff = await hasCapability(tx, req, "certificate:view_issued", row.contextId);
        if (row.issued.userId !== me.id && !staff) throw notFound("Certificate");
        if (row.issued.revokedAt && !staff) throw forbidden("This certificate has been revoked");
        if (!row.issued.fileId) throw notFound("Certificate file");
        const file = must((await tx.select().from(files).where(eq(files.id, row.issued.fileId)).limit(1))[0], "Certificate file");
        return downloadUrl(tx, req, file, req.query.inline);
      });
      reply.header("Cache-Control", "private, no-store");
      return reply.redirect(url, 302);
    },
  );

  app.post(
    "/issued/:id/revoke",
    {
      schema: {
        tags: ["Certificates"],
        summary: "Revoke an issued certificate (certificate:issue)",
        params: z.object({ id: zId }),
        body: z.object({ reason: z.string().trim().max(500).optional() }).default({}),
        response: { 200: zIssued },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        requireUser(req);
        const [row] = await tx
          .select({ issued: issuedCertificates, activityId: activities.id })
          .from(issuedCertificates)
          .innerJoin(certificateActivities, eq(certificateActivities.id, issuedCertificates.certificateActivityId))
          .innerJoin(activities, eq(activities.id, certificateActivities.activityId))
          .where(eq(issuedCertificates.id, req.params.id))
          .limit(1);
        if (!row) throw notFound("Certificate");
        await loadActivity(tx, req, row.activityId, { type: "certificate", capability: "certificate:issue" });
        if (row.issued.revokedAt) return toIssued(row.issued);
        const [updated] = await tx.update(issuedCertificates).set({ revokedAt: new Date() }).where(eq(issuedCertificates.id, row.issued.id)).returning();
        await audit(tx, req, "certificate.revoked", { type: "issued_certificate", id: row.issued.id }, { userId: row.issued.userId, reason: req.body.reason ?? null });
        return toIssued(updated!);
      }),
  );
};
