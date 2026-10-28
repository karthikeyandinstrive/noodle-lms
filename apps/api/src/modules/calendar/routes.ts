import { eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { calendarEvents, getSystemContext } from "@lms/db";
import { z } from "zod";
import { config } from "../../config";
import { audit } from "../../core/audit";
import { requireUser } from "../../core/auth";
import { badRequest, must } from "../../core/errors";
import { hasCapability } from "../../core/rbac";
import { cleanHtml } from "../../core/sanitize";
import { ok, zDate, zDateInput, zId, zOk } from "../../core/schemas";
import { buildIcs } from "./ics";
import { assertCanManage, calendarItems, manageableCourses, type CalendarEventRow } from "./service";

const DAY = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 400;

const zItem = z.object({
  id: z.string(),
  type: z.enum(["site", "course", "user", "due", "session"]),
  name: z.string(),
  description: z.string().nullable(),
  startsAt: zDate,
  durationMinutes: z.number().int(),
  courseId: zId.nullable(),
  courseName: z.string().nullable(),
  activityId: zId.nullable(),
  link: z.string().nullable(),
  editable: z.boolean(),
});

const zEvent = z.object({
  id: zId,
  type: z.enum(["site", "course", "user", "due", "session"]),
  courseId: zId.nullable(),
  userId: zId.nullable(),
  name: z.string(),
  description: z.string().nullable(),
  startsAt: zDate,
  durationMinutes: z.number().int(),
  createdAt: zDate,
});

const zRange = z
  .object({ from: zDateInput, to: zDateInput, courseId: zId.optional() })
  .refine((r) => r.to > r.from, { message: "`to` must be after `from`", path: ["to"] })
  .refine((r) => r.to.getTime() - r.from.getTime() <= MAX_RANGE_DAYS * DAY, { message: `Range is limited to ${MAX_RANGE_DAYS} days`, path: ["to"] });

const zEventInput = z.object({
  type: z.enum(["site", "course", "user"]),
  courseId: zId.nullable().optional(),
  name: z.string().trim().min(1).max(255),
  description: z.string().max(10_000).nullable().optional(),
  startsAt: zDateInput,
  durationMinutes: z.number().int().min(0).max(60 * 24 * 7).default(0),
});

const toEvent = (e: CalendarEventRow) => e;

export const routes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/events",
    {
      schema: {
        tags: ["Calendar"],
        summary: "My calendar in a date range: site, course, own events and activity deadlines",
        querystring: zRange,
        response: { 200: z.array(zItem) },
      },
    },
    (req) => req.tenant((tx) => calendarItems(tx, req, req.query)),
  );

  app.get(
    "/upcoming",
    {
      schema: {
        tags: ["Calendar"],
        summary: "My next events and deadlines (14 days, at most 20)",
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(20).default(20) }),
        response: { 200: z.array(zItem) },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const now = new Date();
        const items = await calendarItems(tx, req, { from: now, to: new Date(now.getTime() + 14 * DAY) });
        return items.filter((i) => i.startsAt >= now || i.durationMinutes > 0).slice(0, req.query.limit);
      }),
  );

  app.get(
    "/export.ics",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["Calendar"],
        summary: "My calendar as an iCalendar (.ics) file",
        querystring: z.object({ from: zDateInput.optional(), to: zDateInput.optional() }),
        response: { 200: z.string().describe("text/calendar") },
      },
    },
    async (req, reply) => {
      const now = Date.now();
      const from = req.query.from ?? new Date(now - 30 * DAY);
      const to = req.query.to ?? new Date(now + 365 * DAY);
      if (to <= from || to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY) throw badRequest(`Invalid range (max ${MAX_RANGE_DAYS} days)`);
      const items = await req.tenant((tx) => calendarItems(tx, req, { from, to }));
      const host = new URL(config.APP_URL).host;
      const ics = buildIcs(
        items.map((i) => ({
          uid: `${i.id.replace(":", "-")}@${host}`,
          name: i.courseName ? `${i.name} (${i.courseName})` : i.name,
          description: i.description,
          startsAt: i.startsAt,
          durationMinutes: i.durationMinutes,
          url: i.link ? `${config.APP_URL}${i.link}` : null,
          categories: [i.type],
        })),
        { calendarName: `${req.org.name} calendar` },
      );
      return reply
        .header("Content-Type", "text/calendar; charset=utf-8")
        .header("Content-Disposition", 'attachment; filename="calendar.ics"')
        .header("Cache-Control", "private, no-store")
        .header("X-Content-Type-Options", "nosniff")
        .send(ics);
    },
  );

  app.get(
    "/permissions",
    {
      schema: {
        tags: ["Calendar"],
        summary: "Which event types I can create (site, and the courses I manage)",
        response: { 200: z.object({ site: z.boolean(), courses: z.array(z.object({ id: zId, fullname: z.string() })) }) },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        requireUser(req);
        const system = await getSystemContext(tx, req.org.id);
        return { site: await hasCapability(tx, req, "calendar:manage_site", system.id), courses: await manageableCourses(tx, req) };
      }),
  );

  app.post(
    "/events",
    { schema: { tags: ["Calendar"], summary: "Create a site, course or personal event", body: zEventInput, response: { 201: zEvent } } },
    async (req, reply) => {
      const me = requireUser(req);
      const event = await req.tenant(async (tx) => {
        const b = req.body;
        if (b.type === "course" && !b.courseId) throw badRequest("courseId is required for course events");
        const target = { type: b.type, courseId: b.type === "course" ? b.courseId! : null, userId: b.type === "user" ? me.id : null };
        await assertCanManage(tx, req, target);
        const [row] = await tx
          .insert(calendarEvents)
          .values({
            organizationId: req.org.id,
            ...target,
            name: b.name,
            description: b.description ? cleanHtml(b.description) : null,
            startsAt: b.startsAt,
            durationMinutes: b.durationMinutes,
            createdBy: me.id,
          })
          .returning();
        if (b.type !== "user") await audit(tx, req, "calendar_event.created", { type: "calendar_event", id: row!.id }, { type: b.type, courseId: target.courseId });
        return row!;
      });
      return reply.status(201).send(toEvent(event));
    },
  );

  app.patch(
    "/events/:id",
    {
      schema: {
        tags: ["Calendar"],
        summary: "Update an event",
        params: z.object({ id: zId }),
        body: zEventInput.omit({ type: true, courseId: true }).partial(),
        response: { 200: zEvent },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const event = must((await tx.select().from(calendarEvents).where(eq(calendarEvents.id, req.params.id)).limit(1))[0], "Event");
        await assertCanManage(tx, req, event);
        const patch = { ...req.body, ...(req.body.description !== undefined ? { description: req.body.description ? cleanHtml(req.body.description) : null } : {}) };
        const [row] = Object.keys(patch).length ? await tx.update(calendarEvents).set(patch).where(eq(calendarEvents.id, event.id)).returning() : [event];
        if (event.type !== "user") await audit(tx, req, "calendar_event.updated", { type: "calendar_event", id: event.id });
        return toEvent(row!);
      }),
  );

  app.delete(
    "/events/:id",
    { schema: { tags: ["Calendar"], summary: "Delete an event", params: z.object({ id: zId }), response: { 200: zOk } } },
    async (req) => {
      await req.tenant(async (tx) => {
        const event = must((await tx.select().from(calendarEvents).where(eq(calendarEvents.id, req.params.id)).limit(1))[0], "Event");
        await assertCanManage(tx, req, event);
        await tx.delete(calendarEvents).where(eq(calendarEvents.id, event.id));
        if (event.type !== "user") await audit(tx, req, "calendar_event.deleted", { type: "calendar_event", id: event.id }, { name: event.name });
      });
      return ok;
    },
  );
};
