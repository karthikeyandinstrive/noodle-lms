import { and, count, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { enrolments, notificationPreferences, notifications } from "@lms/db";
import { z } from "zod";
import { audit } from "../../core/audit";
import { requireUser } from "../../core/auth";
import { badRequest } from "../../core/errors";
import { NOTIFICATION_TYPES, notify, type NotificationType } from "../../core/notify";
import { offset, ok, paged, zDate, zId, zNullableDate, zOk, zPagination } from "../../core/schemas";
import { loadCourseWith } from "../courses/service";

const TYPES = Object.keys(NOTIFICATION_TYPES) as [NotificationType, ...NotificationType[]];
const zType = z.enum(TYPES);

const zNotification = z.object({
  id: zId,
  type: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  link: z.string().nullable(),
  readAt: zNullableDate,
  createdAt: zDate,
});

const zPreference = z.object({ type: zType, label: z.string(), inApp: z.boolean(), email: z.boolean() });

export const routes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/",
    {
      schema: {
        tags: ["Notifications"],
        summary: "My notifications (newest first)",
        querystring: zPagination.extend({ unread: z.enum(["true", "false"]).transform((v) => v === "true").optional() }),
        response: { 200: paged(zNotification) },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const me = requireUser(req);
        const q = req.query;
        const where = and(eq(notifications.userId, me.id), q.unread ? isNull(notifications.readAt) : undefined);
        const [items, [{ total }]] = (await Promise.all([
          tx
            .select({
              id: notifications.id,
              type: notifications.type,
              title: notifications.title,
              body: notifications.body,
              link: notifications.link,
              readAt: notifications.readAt,
              createdAt: notifications.createdAt,
            })
            .from(notifications)
            .where(where)
            .orderBy(desc(notifications.createdAt))
            .limit(q.pageSize)
            .offset(offset(q)),
          tx.select({ total: count() }).from(notifications).where(where),
        ])) as [z.infer<typeof zNotification>[], [{ total: number }]];
        return { items, total, page: q.page, pageSize: q.pageSize };
      }),
  );

  app.get(
    "/unread-count",
    { schema: { tags: ["Notifications"], summary: "Number of unread notifications", response: { 200: z.object({ count: z.number().int() }) } } },
    (req) =>
      req.tenant(async (tx) => {
        const me = requireUser(req);
        const [row] = await tx
          .select({ n: count() })
          .from(notifications)
          .where(and(eq(notifications.userId, me.id), isNull(notifications.readAt)));
        return { count: row?.n ?? 0 };
      }),
  );

  app.post(
    "/read",
    {
      schema: {
        tags: ["Notifications"],
        summary: "Mark notifications as read (given ids, or all)",
        body: z.union([z.object({ ids: z.array(zId).min(1).max(500) }), z.object({ all: z.literal(true) })]),
        response: { 200: z.object({ updated: z.number().int() }) },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const me = requireUser(req);
        const body = req.body;
        const rows = await tx
          .update(notifications)
          .set({ readAt: new Date() })
          .where(
            and(
              // Ownership: only the caller's own notifications are ever touched.
              eq(notifications.userId, me.id),
              isNull(notifications.readAt),
              "ids" in body ? inArray(notifications.id, body.ids) : undefined,
            ),
          )
          .returning({ id: notifications.id });
        return { updated: rows.length };
      }),
  );

  app.get(
    "/preferences",
    { schema: { tags: ["Notifications"], summary: "My delivery preferences per notification type", response: { 200: z.array(zPreference) } } },
    (req) =>
      req.tenant(async (tx) => {
        const me = requireUser(req);
        const rows = await tx.select().from(notificationPreferences).where(eq(notificationPreferences.userId, me.id));
        const prefOf = new Map(rows.map((r) => [r.type, r]));
        return TYPES.map((type) => ({
          type,
          label: NOTIFICATION_TYPES[type],
          inApp: prefOf.get(type)?.inApp ?? true,
          email: prefOf.get(type)?.email ?? true,
        }));
      }),
  );

  app.put(
    "/preferences",
    {
      schema: {
        tags: ["Notifications"],
        summary: "Update my delivery preferences",
        body: z.object({ preferences: z.array(z.object({ type: zType, inApp: z.boolean(), email: z.boolean() })).min(1).max(TYPES.length) }),
        response: { 200: z.array(zPreference) },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const me = requireUser(req);
        const seen = new Set<string>();
        for (const p of req.body.preferences) {
          if (seen.has(p.type)) throw badRequest(`Duplicate preference for ${p.type}`);
          seen.add(p.type);
          await tx
            .insert(notificationPreferences)
            .values({ organizationId: req.org.id, userId: me.id, type: p.type, inApp: p.inApp, email: p.email })
            .onConflictDoUpdate({ target: [notificationPreferences.userId, notificationPreferences.type], set: { inApp: p.inApp, email: p.email } });
        }
        const rows = await tx.select().from(notificationPreferences).where(eq(notificationPreferences.userId, me.id));
        const prefOf = new Map(rows.map((r) => [r.type, r]));
        return TYPES.map((type) => ({
          type,
          label: NOTIFICATION_TYPES[type],
          inApp: prefOf.get(type)?.inApp ?? true,
          email: prefOf.get(type)?.email ?? true,
        }));
      }),
  );

  app.post(
    "/courses/:courseId/announce",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["Notifications"],
        summary: "Send an announcement to every active participant of a course",
        params: z.object({ courseId: zId }),
        body: z.object({ title: z.string().trim().min(1).max(200), body: z.string().trim().max(5000).optional() }),
        response: { 200: z.object({ sent: z.number().int() }) },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const me = requireUser(req);
        const course = await loadCourseWith(tx, req, req.params.courseId, "notification:send");
        const recipients = await tx
          .select({ userId: enrolments.userId })
          .from(enrolments)
          .where(and(eq(enrolments.courseId, course.id), eq(enrolments.status, "active"), ne(enrolments.userId, me.id)));
        const userIds = recipients.map((r) => r.userId);
        // Notification bodies are plain text (rendered as text, emailed as text) — no HTML.
        await notify(tx, {
          organizationId: req.org.id,
          userIds,
          type: "announcement",
          title: `${course.shortname}: ${req.body.title}`,
          body: req.body.body,
          link: `/courses/${course.id}`,
        });
        await audit(tx, req, "course.announcement_sent", { type: "course", id: course.id }, { recipients: userIds.length, title: req.body.title });
        return { sent: userIds.length };
      }),
  );

  app.delete(
    "/:id",
    { schema: { tags: ["Notifications"], summary: "Delete one of my notifications", params: z.object({ id: zId }), response: { 200: zOk } } },
    async (req) => {
      await req.tenant(async (tx) => {
        const me = requireUser(req);
        await tx.delete(notifications).where(and(eq(notifications.id, req.params.id), eq(notifications.userId, me.id)));
      });
      return ok;
    },
  );
};
