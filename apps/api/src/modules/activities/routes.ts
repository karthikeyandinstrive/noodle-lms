import { and, eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { activities, activityCompletions, createContext } from "@lms/db";
import { z } from "zod";
import { activityType, registeredActivityTypes, type ActivityType } from "../../core/activity-types";
import { requireUser } from "../../core/auth";
import { audit } from "../../core/audit";
import { badRequest } from "../../core/errors";
import { emit } from "../../core/events";
import { capabilityMap } from "../../core/rbac";
import { cleanHtml } from "../../core/sanitize";
import { ok, zDate, zDateInput, zId, zNullableDate, zOk } from "../../core/schemas";
import { syncActivityGradeItem } from "../gradebook/service";
import { loadCourseWith } from "../courses/service";
import { loadActivity, nextActivityPosition, sectionInCourse } from "./service";

const TYPES = [
  "page",
  "url",
  "file",
  "assignment",
  "quiz",
  "forum",
  "workshop",
  "attendance",
  "interactive",
  "video",
  "certificate",
] as const satisfies readonly ActivityType[];

const zActivity = z.object({
  id: zId,
  courseId: zId,
  sectionId: zId,
  contextId: zId,
  type: z.enum(TYPES),
  name: z.string(),
  description: z.string().nullable(),
  position: z.number().int(),
  visible: z.boolean(),
  availableFrom: zNullableDate,
  availableUntil: zNullableDate,
  completionRule: z.enum(["none", "manual", "view", "submit", "grade", "pass"]),
  groupMode: z.string(),
  createdAt: zDate,
});

const zCommon = z.object({
  sectionId: zId,
  name: z.string().trim().min(1).max(255),
  description: z.string().max(50_000).nullable().optional(),
  visible: z.boolean().default(true),
  availableFrom: zDateInput.nullable().optional(),
  availableUntil: zDateInput.nullable().optional(),
  completionRule: z.enum(["none", "manual", "view", "submit", "grade", "pass"]).default("none"),
  groupMode: z.enum(["none", "separate", "visible"]).default("none"),
});

const activityCaps = [
  "activity:update",
  "activity:delete",
  "activity:grade",
  "course:view_hidden",
  "assignment:submit",
  "assignment:view_submissions",
  "assignment:grade",
  "quiz:attempt",
  "quiz:preview",
  "quiz:view_reports",
  "quiz:grade",
  "forum:view",
  "forum:start_discussion",
  "forum:reply",
  "forum:moderate",
  "forum:post_news",
  "workshop:submit",
  "workshop:peer_assess",
  "workshop:manage",
  "attendance:take",
  "attendance:view_all",
  "attendance:self_mark",
  "certificate:issue",
  "certificate:view_issued",
  "interactive:view",
  "interactive:view_results",
  "video:join",
  "video:moderate",
  "completion:override",
] as const;

export const routes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/activity-types",
    {
      schema: {
        tags: ["Activities"],
        summary: "Available activity types and their settings schema",
        response: { 200: z.array(z.object({ type: z.string(), label: z.string(), gradable: z.boolean() })) },
      },
    },
    async () => registeredActivityTypes().map((t) => ({ type: t.type, label: t.label, gradable: !!t.grading })),
  );

  app.post(
    "/courses/:courseId/activities",
    {
      schema: {
        tags: ["Activities"],
        summary: "Add an activity. `settings` is validated by the activity type.",
        params: z.object({ courseId: zId }),
        body: zCommon.extend({ type: z.enum(TYPES), settings: z.record(z.unknown()).default({}) }),
        response: { 201: zActivity.extend({ settings: z.record(z.unknown()).nullable() }) },
      },
    },
    async (req, reply) => {
      const me = requireUser(req);
      const result = await req.tenant(async (tx) => {
        // Authorize before looking at the payload.
        const course = await loadCourseWith(tx, req, req.params.courseId, "activity:create");
        const handler = activityType(req.body.type);
        const parsed = handler.settings.safeParse(req.body.settings);
        if (!parsed.success) throw badRequest("Invalid activity settings", parsed.error.flatten());
        await sectionInCourse(tx, req.body.sectionId, course.id);
        const { settings: _settings, ...common } = req.body;
        const id = crypto.randomUUID();
        const ctx = await createContext(tx, { organizationId: req.org.id, level: "activity", instanceId: id, parentId: course.contextId });
        const [activity] = await tx
          .insert(activities)
          .values({
            ...common,
            description: common.description ? cleanHtml(common.description) : null,
            id,
            organizationId: req.org.id,
            courseId: course.id,
            contextId: ctx.id,
            position: await nextActivityPosition(tx, req.body.sectionId),
            createdBy: me.id,
          })
          .returning();
        await handler.create(tx, { organizationId: req.org.id, userId: me.id, activity: activity! }, parsed.data);
        if (handler.grading) await syncActivityGradeItem(tx, activity!, await handler.grading(tx, activity!));
        await audit(tx, req, "activity.created", { type: "activity", id }, { type: activity!.type });
        return { ...activity!, settings: await handler.load(tx, activity!) };
      });
      await emit("activity.created", { organizationId: req.org.id, activityId: result.id, courseId: result.courseId, type: result.type, userId: me.id });
      return reply.status(201).send(result);
    },
  );

  app.get(
    "/activities/:id",
    {
      schema: {
        tags: ["Activities"],
        summary: "Get an activity with its settings and my capabilities (records a view)",
        params: z.object({ id: zId }),
        response: {
          200: zActivity.extend({
            settings: z.record(z.unknown()).nullable(),
            capabilities: z.record(z.boolean()),
            completion: z.string().nullable(),
            course: z.object({ id: zId, fullname: z.string() }),
          }),
        },
      },
    },
    async (req) => {
      const out = await req.tenant(async (tx) => {
        const { activity, course } = await loadActivity(tx, req, req.params.id);
        const caps = await capabilityMap(tx, req, [...activityCaps], activity.contextId);
        const [completion] = req.user
          ? await tx.select().from(activityCompletions).where(and(eq(activityCompletions.activityId, activity.id), eq(activityCompletions.userId, req.user.id))).limit(1)
          : [];
        return {
          ...activity,
          settings: await activityType(activity.type).load(tx, activity),
          capabilities: caps as Record<string, boolean>,
          completion: activity.completionRule === "none" ? null : (completion?.state ?? "incomplete"),
          course: { id: course.id, fullname: course.fullname },
        };
      });
      if (req.user) {
        await emit("activity.viewed", { organizationId: req.org.id, activityId: out.id, courseId: out.courseId, userId: req.user.id });
      }
      return out;
    },
  );

  app.patch(
    "/activities/:id",
    {
      schema: {
        tags: ["Activities"],
        summary: "Update an activity and/or its type settings",
        params: z.object({ id: zId }),
        body: zCommon.partial().extend({ settings: z.record(z.unknown()).optional() }),
        response: { 200: zActivity.extend({ settings: z.record(z.unknown()).nullable() }) },
      },
    },
    async (req) => {
      const me = requireUser(req);
      const result = await req.tenant(async (tx) => {
        const { activity } = await loadActivity(tx, req, req.params.id, { capability: "activity:update" });
        const handler = activityType(activity.type);
        const { settings, ...common } = req.body;
        if (common.sectionId) await sectionInCourse(tx, common.sectionId, activity.courseId);
        const patch = { ...common, ...(common.description !== undefined ? { description: common.description ? cleanHtml(common.description) : null } : {}) };
        const [updated] = Object.keys(patch).length
          ? await tx.update(activities).set(patch).where(eq(activities.id, activity.id)).returning()
          : [activity];
        if (settings) {
          const parsed = handler.settings.partial().safeParse(settings);
          if (!parsed.success) throw badRequest("Invalid activity settings", parsed.error.flatten());
          await handler.update(tx, { organizationId: req.org.id, userId: me.id, activity: updated! }, parsed.data);
        }
        if (handler.grading) await syncActivityGradeItem(tx, updated!, await handler.grading(tx, updated!));
        await audit(tx, req, "activity.updated", { type: "activity", id: activity.id });
        return { ...updated!, settings: await handler.load(tx, updated!) };
      });
      await emit("activity.updated", { organizationId: req.org.id, activityId: result.id, courseId: result.courseId, type: result.type, userId: me.id });
      return result;
    },
  );

  app.delete(
    "/activities/:id",
    { schema: { tags: ["Activities"], summary: "Delete an activity and all its data", params: z.object({ id: zId }), response: { 200: zOk } } },
    async (req) => {
      const deleted = await req.tenant(async (tx) => {
        const { activity } = await loadActivity(tx, req, req.params.id, { capability: "activity:delete" });
        await tx.delete(activities).where(eq(activities.id, activity.id));
        await audit(tx, req, "activity.deleted", { type: "activity", id: activity.id }, { name: activity.name, type: activity.type });
        return activity;
      });
      await emit("activity.deleted", { organizationId: req.org.id, activityId: deleted.id, courseId: deleted.courseId, type: deleted.type, userId: req.user?.id });
      return ok;
    },
  );

  app.put(
    "/courses/:courseId/sections/:sectionId/activities/order",
    {
      schema: {
        tags: ["Activities"],
        summary: "Reorder (or move into) a section",
        params: z.object({ courseId: zId, sectionId: zId }),
        body: z.object({ activityIds: z.array(zId) }),
        response: { 200: zOk },
      },
    },
    async (req) => {
      await req.tenant(async (tx) => {
        const course = await loadCourseWith(tx, req, req.params.courseId, "course:update");
        await sectionInCourse(tx, req.params.sectionId, course.id);
        for (const [position, id] of req.body.activityIds.entries()) {
          await tx
            .update(activities)
            .set({ position, sectionId: req.params.sectionId })
            .where(and(eq(activities.id, id), eq(activities.courseId, course.id)));
        }
      });
      return ok;
    },
  );
};
