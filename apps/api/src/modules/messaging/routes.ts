import { and, asc, count, desc, eq, ilike, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { conversationMembers, conversations, courses, enrolments, messages, notifications, userBlocks, users } from "@lms/db";
import { z } from "zod";
import { requireUser } from "../../core/auth";
import { badRequest, forbidden, must, notFound } from "../../core/errors";
import { emitInTx } from "../../core/events";
import { liveListenerCount, publishLive, subscribeLive } from "../../core/live";
import { hasCapability } from "../../core/rbac";
import { cleanHtml } from "../../core/sanitize";
import { offset, ok, paged, zDate, zId, zNullableDate, zOk, zPagination } from "../../core/schemas";
import {
  activeCourseUserIds,
  addMembers,
  assertCanMessage,
  canMessage,
  canMessageAnyone,
  canSendAtAll,
  conversationLink,
  courseConversation,
  EDIT_WINDOW_MS,
  findOrCreateDirect,
  hasBlocked,
  isMuted,
  likeEscape,
  loadConversation,
  MAX_BODY,
  memberIds,
  messagingCourseIds,
  plainPreview,
  unreadCounts,
} from "./service";

// ─── Schemas ────────────────────────────────────────────────────────────────

const zPerson = z.object({ id: zId, firstName: z.string(), lastName: z.string() });

const zConversation = z.object({
  id: zId,
  type: z.enum(["direct", "group", "course"]),
  name: z.string().nullable(),
  courseId: zId.nullable(),
  createdBy: zId.nullable(),
  lastMessageAt: zNullableDate,
  createdAt: zDate,
  members: z.array(zPerson),
  /** For direct conversations: the other person. */
  otherUser: zPerson.nullable(),
  /** For direct conversations: whether I blocked the other person. */
  blocked: z.boolean(),
  muted: z.boolean(),
  unread: z.number().int(),
  lastReadAt: zNullableDate,
  lastMessage: z
    .object({ id: zId, userId: zId, preview: z.string(), createdAt: zDate, deleted: z.boolean() })
    .nullable(),
  /** Whether I can post in it (e.g. not blocked, still allowed to message). */
  canPost: z.boolean(),
});

const zMessage = z.object({
  id: zId,
  conversationId: zId,
  user: zPerson,
  body: z.string(),
  createdAt: zDate,
  updatedAt: zDate,
  edited: z.boolean(),
  deleted: z.boolean(),
  mine: z.boolean(),
  canEdit: z.boolean(),
});

const zBody = z.object({ body: z.string().trim().min(1).max(MAX_BODY) });
const idParam = z.object({ id: zId });

const rateLimited = { rateLimit: { max: 30, timeWindow: "1 minute" } };

type Tx = Parameters<Parameters<import("fastify").FastifyRequest["tenant"]>[0]>[0];

function sanitizeBody(raw: string) {
  const body = cleanHtml(raw).trim();
  if (!body) throw badRequest("Message is empty");
  return body;
}

async function people(tx: Tx, ids: string[]) {
  if (!ids.length) return new Map<string, z.infer<typeof zPerson>>();
  const rows = await tx.select({ id: users.id, firstName: users.firstName, lastName: users.lastName }).from(users).where(inArray(users.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, r]));
}

/** Builds conversation summaries for the current user. */
async function summarize(tx: Tx, req: import("fastify").FastifyRequest, convIds: string[]) {
  const me = requireUser(req);
  if (!convIds.length) return [];
  const rows = await tx
    .select({ conversation: conversations, member: conversationMembers })
    .from(conversations)
    .innerJoin(conversationMembers, and(eq(conversationMembers.conversationId, conversations.id), eq(conversationMembers.userId, me.id)))
    .where(inArray(conversations.id, convIds));
  const allMembers = await tx
    .select({ conversationId: conversationMembers.conversationId, userId: conversationMembers.userId })
    .from(conversationMembers)
    .where(inArray(conversationMembers.conversationId, convIds));
  const membersOf = new Map<string, string[]>();
  for (const m of allMembers) membersOf.set(m.conversationId, [...(membersOf.get(m.conversationId) ?? []), m.userId]);
  // Member lists of big course conversations are capped for display.
  const shownIds = [...new Set([...membersOf.values()].flatMap((ids) => ids.slice(0, 50)))];
  const who = await people(tx, shownIds);

  const last = await tx
    .selectDistinctOn([messages.conversationId], {
      id: messages.id,
      conversationId: messages.conversationId,
      userId: messages.userId,
      body: messages.body,
      createdAt: messages.createdAt,
      deletedAt: messages.deletedAt,
    })
    .from(messages)
    .where(inArray(messages.conversationId, convIds))
    .orderBy(messages.conversationId, desc(messages.createdAt));
  const lastOf = new Map(last.map((m) => [m.conversationId, m]));
  const unread = await unreadCounts(tx, me.id, convIds);

  const blocks = await tx.select({ blockedUserId: userBlocks.blockedUserId }).from(userBlocks).where(eq(userBlocks.userId, me.id));
  const blockedSet = new Set(blocks.map((b) => b.blockedUserId));

  const out = [];
  for (const { conversation: c, member } of rows) {
    const ids = membersOf.get(c.id) ?? [];
    const otherId = c.type === "direct" ? (ids.find((id) => id !== me.id) ?? null) : null;
    const lm = lastOf.get(c.id);
    let canPost = true;
    if (c.type === "direct" && otherId) {
      canPost = !blockedSet.has(otherId) && !(await hasBlocked(tx, otherId, me.id));
    }
    out.push({
      id: c.id,
      type: c.type,
      name: c.name,
      courseId: c.courseId,
      createdBy: c.createdBy,
      lastMessageAt: c.lastMessageAt,
      createdAt: c.createdAt,
      members: ids.slice(0, 50).flatMap((id) => (who.get(id) ? [who.get(id)!] : [])),
      otherUser: otherId ? (who.get(otherId) ?? null) : null,
      blocked: otherId ? blockedSet.has(otherId) : false,
      muted: isMuted(member),
      unread: unread.get(c.id) ?? 0,
      lastReadAt: member.lastReadAt,
      lastMessage: lm
        ? { id: lm.id, userId: lm.userId, preview: lm.deletedAt ? "" : plainPreview(lm.body), createdAt: lm.createdAt, deleted: !!lm.deletedAt }
        : null,
      canPost,
    });
  }
  return out.sort((a, b) => +(b.lastMessageAt ?? b.createdAt) - +(a.lastMessageAt ?? a.createdAt));
}

function toMessage(m: typeof messages.$inferSelect, who: Map<string, z.infer<typeof zPerson>>, meId: string) {
  const deleted = !!m.deletedAt;
  const mine = m.userId === meId;
  return {
    id: m.id,
    conversationId: m.conversationId,
    user: who.get(m.userId) ?? { id: m.userId, firstName: "", lastName: "" },
    body: deleted ? "" : m.body,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    edited: !deleted && m.updatedAt.getTime() - m.createdAt.getTime() > 1000,
    deleted,
    mine,
    canEdit: mine && !deleted && Date.now() - m.createdAt.getTime() < EDIT_WINDOW_MS,
  };
}

async function loadOwnMessage(tx: Tx, req: import("fastify").FastifyRequest, messageId: string) {
  const me = requireUser(req);
  const msg = must((await tx.select().from(messages).where(eq(messages.id, messageId)).limit(1))[0], "Message");
  // Membership first, so non-members can't probe message ids.
  await loadConversation(tx, req, msg.conversationId);
  if (msg.userId !== me.id) throw forbidden("You can only change your own messages");
  if (msg.deletedAt) throw notFound("Message");
  if (Date.now() - msg.createdAt.getTime() > EDIT_WINDOW_MS) throw forbidden("Messages can only be changed within 15 minutes");
  return msg;
}

// ─── Routes ─────────────────────────────────────────────────────────────────

/** Open live streams per user (more tabs than this fall back to polling). */
const MAX_STREAMS_PER_USER = 10;
const HEARTBEAT_MS = 25_000;

export const routes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/stream",
    {
      schema: {
        tags: ["Messaging"],
        summary: "Server-sent events: `message` (a conversation of mine changed) and `notification` (my notifications changed) — hints to refetch, no content",
      },
    },
    async (req, reply) => {
      const me = requireUser(req);
      if (liveListenerCount(me.id) >= MAX_STREAMS_PER_USER) return reply.status(429).send({ error: { code: "TOO_MANY_STREAMS", message: "Too many open live connections" } });
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write("retry: 5000\n: connected\n\n");
      const unsubscribe = subscribeLive(me.id, (event) => {
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      });
      const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
      const close = () => {
        clearInterval(heartbeat);
        unsubscribe();
      };
      req.raw.on("close", close);
      res.on("error", close);
    },
  );

  app.get(
    "/conversations",
    {
      schema: {
        tags: ["Messaging"],
        summary: "My conversations with last message preview and unread count",
        response: { 200: z.array(zConversation) },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const me = requireUser(req);
        const mine = await tx
          .select({ id: conversations.id })
          .from(conversationMembers)
          .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
          .where(eq(conversationMembers.userId, me.id))
          .orderBy(sql`coalesce(${conversations.lastMessageAt}, ${conversations.createdAt}) desc`)
          .limit(200);
        return summarize(tx, req, mine.map((r) => r.id));
      }),
  );

  app.get(
    "/conversations/:id",
    { schema: { tags: ["Messaging"], summary: "One conversation (members only)", params: idParam, response: { 200: zConversation } } },
    (req) =>
      req.tenant(async (tx) => {
        await loadConversation(tx, req, req.params.id);
        return (await summarize(tx, req, [req.params.id]))[0]!;
      }),
  );

  app.post(
    "/conversations",
    {
      schema: {
        tags: ["Messaging"],
        summary: "Start a conversation. Direct: finds or creates the one conversation with that user.",
        body: z.discriminatedUnion("type", [
          z.object({ type: z.literal("direct"), userId: zId }),
          z.object({ type: z.literal("group"), name: z.string().trim().min(1).max(200), userIds: z.array(zId).min(1).max(100) }),
          z.object({ type: z.literal("course"), courseId: zId }),
        ]),
        response: { 200: zConversation },
      },
      config: rateLimited,
    },
    (req) =>
      req.tenant(async (tx) => {
        const me = requireUser(req);
        const body = req.body;
        let id: string;
        if (body.type === "direct") {
          if (body.userId === me.id) throw badRequest("You cannot message yourself");
          await assertCanMessage(tx, req, body.userId);
          id = (await findOrCreateDirect(tx, req.org.id, me.id, body.userId)).conversation.id;
        } else if (body.type === "group") {
          if (!(await canSendAtAll(tx, req))) throw forbidden("Missing capability message:send");
          const others = [...new Set(body.userIds.filter((u) => u !== me.id))];
          if (!others.length) throw badRequest("Add at least one other member");
          for (const u of others) await assertCanMessage(tx, req, u);
          const [conv] = await tx
            .insert(conversations)
            .values({ organizationId: req.org.id, type: "group", name: body.name, createdBy: me.id })
            .returning();
          await addMembers(tx, conv!, [me.id, ...others]);
          id = conv!.id;
        } else {
          // Course conversation: one per course, created on demand by staff.
          const course = must((await tx.select().from(courses).where(eq(courses.id, body.courseId)).limit(1))[0], "Course");
          if (!(await hasCapability(tx, req, "course:view", course.contextId))) throw notFound("Course");
          const isStaff = await hasCapability(tx, req, "notification:send", course.contextId);
          let conv = await courseConversation(tx, course.id);
          if (!conv) {
            if (!isStaff) throw forbidden("Only course staff can start the course conversation");
            const [created] = await tx
              .insert(conversations)
              .values({ organizationId: req.org.id, type: "course", courseId: course.id, name: course.fullname, createdBy: me.id })
              .returning();
            conv = created!;
          }
          // Sync membership with active participants (new enrolments are also added by an event subscriber).
          await addMembers(tx, conv!, [...(await activeCourseUserIds(tx, course.id)), ...(isStaff ? [me.id] : [])]);
          id = conv!.id;
        }
        await loadConversation(tx, req, id);
        return (await summarize(tx, req, [id]))[0]!;
      }),
  );

  app.post(
    "/conversations/:id/members",
    {
      schema: {
        tags: ["Messaging"],
        summary: "Add people to a group conversation (creator only)",
        params: idParam,
        body: z.object({ userIds: z.array(zId).min(1).max(100) }),
        response: { 200: zOk },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const me = requireUser(req);
        const { conversation } = await loadConversation(tx, req, req.params.id);
        if (conversation.type !== "group" || conversation.createdBy !== me.id) throw forbidden();
        const current = new Set(await memberIds(tx, conversation.id));
        const add = req.body.userIds.filter((u) => !current.has(u));
        for (const u of add) await assertCanMessage(tx, req, u);
        await addMembers(tx, conversation, add);
        return ok;
      }),
  );

  app.delete(
    "/conversations/:id/members/me",
    { schema: { tags: ["Messaging"], summary: "Leave a group conversation", params: idParam, response: { 200: zOk } } },
    (req) =>
      req.tenant(async (tx) => {
        const me = requireUser(req);
        const { conversation } = await loadConversation(tx, req, req.params.id);
        if (conversation.type !== "group") throw badRequest("Only group conversations can be left");
        await tx
          .delete(conversationMembers)
          .where(and(eq(conversationMembers.conversationId, conversation.id), eq(conversationMembers.userId, me.id)));
        return ok;
      }),
  );

  app.get(
    "/conversations/:id/messages",
    {
      schema: {
        tags: ["Messaging"],
        summary: "Messages in a conversation, newest first (members only)",
        params: idParam,
        querystring: zPagination.extend({ pageSize: z.coerce.number().int().min(1).max(100).default(30) }),
        response: { 200: paged(zMessage) },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const me = requireUser(req);
        await loadConversation(tx, req, req.params.id);
        const where = eq(messages.conversationId, req.params.id);
        const [rows, [{ total }]] = (await Promise.all([
          tx.select().from(messages).where(where).orderBy(desc(messages.createdAt), desc(messages.id)).limit(req.query.pageSize).offset(offset(req.query)),
          tx.select({ total: count() }).from(messages).where(where),
        ])) as [(typeof messages.$inferSelect)[], [{ total: number }]];
        const who = await people(tx, rows.map((m) => m.userId));
        return { items: rows.map((m) => toMessage(m, who, me.id)), total, page: req.query.page, pageSize: req.query.pageSize };
      }),
  );

  app.post(
    "/conversations/:id/messages",
    {
      schema: {
        tags: ["Messaging"],
        summary: "Send a message (body is sanitized HTML or plain text, max 10 000 chars)",
        params: idParam,
        body: zBody,
        response: { 201: zMessage },
      },
      config: rateLimited,
    },
    async (req, reply) => {
      const out = await req.tenant(async (tx) => {
        const me = requireUser(req);
        const { conversation } = await loadConversation(tx, req, req.params.id);
        if (conversation.type === "direct") {
          const otherId = (await memberIds(tx, conversation.id)).find((u) => u !== me.id);
          if (!otherId) throw badRequest("This conversation has no recipient");
          if (await hasBlocked(tx, me.id, otherId)) throw forbidden("Unblock this user to send them messages");
          if (await hasBlocked(tx, otherId, me.id)) throw forbidden("This user is not accepting messages from you");
          if (!(await canMessage(tx, req, otherId))) {
            // Replying is allowed when the other person wrote to you first (e.g. staff with message:send_any).
            const [theirs] = await tx
              .select({ id: messages.id })
              .from(messages)
              .where(and(eq(messages.conversationId, conversation.id), eq(messages.userId, otherId)))
              .limit(1);
            if (!theirs) throw forbidden("You cannot message this user");
          }
        } else if (conversation.type === "course" && conversation.courseId) {
          const [course] = await tx.select({ contextId: courses.contextId }).from(courses).where(eq(courses.id, conversation.courseId)).limit(1);
          if (!course || !(await hasCapability(tx, req, "course:view", course.contextId))) throw forbidden("You are no longer a participant of this course");
        }
        const now = new Date();
        const [msg] = await tx
          .insert(messages)
          .values({ organizationId: req.org.id, conversationId: conversation.id, userId: me.id, body: sanitizeBody(req.body.body), createdAt: now, updatedAt: now })
          .returning();
        await tx.update(conversations).set({ lastMessageAt: now }).where(eq(conversations.id, conversation.id));
        await tx
          .update(conversationMembers)
          .set({ lastReadAt: now })
          .where(and(eq(conversationMembers.conversationId, conversation.id), eq(conversationMembers.userId, me.id)));
        await emitInTx(tx, "message.sent", {
          organizationId: req.org.id,
          conversationId: conversation.id,
          messageId: msg!.id,
          userId: me.id,
          courseId: conversation.courseId,
        });
        return { message: toMessage(msg!, await people(tx, [me.id]), me.id), members: await memberIds(tx, conversation.id), conversationId: conversation.id };
      });
      await publishLive(out.members, { type: "message", conversationId: out.conversationId });
      return reply.status(201).send(out.message);
    },
  );

  app.patch(
    "/:id",
    {
      schema: { tags: ["Messaging"], summary: "Edit my message (within 15 minutes)", params: idParam, body: zBody, response: { 200: zMessage } },
      config: rateLimited,
    },
    async (req) => {
      const out = await req.tenant(async (tx) => {
        const me = requireUser(req);
        const msg = await loadOwnMessage(tx, req, req.params.id);
        const [updated] = await tx
          .update(messages)
          .set({ body: sanitizeBody(req.body.body), updatedAt: new Date() })
          .where(eq(messages.id, msg.id))
          .returning();
        return { message: toMessage(updated!, await people(tx, [me.id]), me.id), members: await memberIds(tx, msg.conversationId), conversationId: msg.conversationId };
      });
      await publishLive(out.members, { type: "message", conversationId: out.conversationId });
      return out.message;
    },
  );

  app.delete(
    "/:id",
    { schema: { tags: ["Messaging"], summary: "Delete my message (within 15 minutes; soft delete)", params: idParam, response: { 200: zOk } } },
    async (req) => {
      const out = await req.tenant(async (tx) => {
        const msg = await loadOwnMessage(tx, req, req.params.id);
        await tx.update(messages).set({ deletedAt: new Date(), body: "" }).where(eq(messages.id, msg.id));
        return { members: await memberIds(tx, msg.conversationId), conversationId: msg.conversationId };
      });
      await publishLive(out.members, { type: "message", conversationId: out.conversationId });
      return ok;
    },
  );

  app.post(
    "/conversations/:id/read",
    { schema: { tags: ["Messaging"], summary: "Mark a conversation as read", params: idParam, response: { 200: zOk } } },
    (req) =>
      req.tenant(async (tx) => {
        const me = requireUser(req);
        const { conversation } = await loadConversation(tx, req, req.params.id);
        const now = new Date();
        await tx
          .update(conversationMembers)
          .set({ lastReadAt: now })
          .where(and(eq(conversationMembers.conversationId, conversation.id), eq(conversationMembers.userId, me.id)));
        // The pending "new message" notification for this conversation is now moot.
        await tx
          .update(notifications)
          .set({ readAt: now })
          .where(
            and(
              eq(notifications.userId, me.id),
              eq(notifications.type, "message"),
              eq(notifications.link, conversationLink(conversation.id)),
              isNull(notifications.readAt),
            ),
          );
        return ok;
      }),
  );

  app.put(
    "/conversations/:id/mute",
    {
      schema: {
        tags: ["Messaging"],
        summary: "Mute or unmute a conversation (no notifications, not counted as unread)",
        params: idParam,
        body: z.object({ muted: z.boolean() }),
        response: { 200: zOk },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const me = requireUser(req);
        const { conversation } = await loadConversation(tx, req, req.params.id);
        await tx
          .update(conversationMembers)
          .set({ muted: req.body.muted ? new Date().toISOString() : null })
          .where(and(eq(conversationMembers.conversationId, conversation.id), eq(conversationMembers.userId, me.id)));
        return ok;
      }),
  );

  app.get(
    "/unread-count",
    { schema: { tags: ["Messaging"], summary: "Unread messages across my (non-muted) conversations", response: { 200: z.object({ count: z.number().int() }) } } },
    (req) =>
      req.tenant(async (tx) => {
        const me = requireUser(req);
        const memberships = await tx
          .select({ conversationId: conversationMembers.conversationId, muted: conversationMembers.muted })
          .from(conversationMembers)
          .where(eq(conversationMembers.userId, me.id));
        const ids = memberships.filter((m) => !isMuted(m)).map((m) => m.conversationId);
        const counts = await unreadCounts(tx, me.id, ids);
        let total = 0;
        for (const n of counts.values()) total += n;
        return { count: total };
      }),
  );

  app.get(
    "/contacts",
    {
      schema: {
        tags: ["Messaging"],
        summary: "People I may message (shared courses, or anyone with message:send_any)",
        querystring: z.object({ search: z.string().trim().max(100).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }),
        response: { 200: z.array(zPerson.extend({ blocked: z.boolean() })) },
      },
    },
    (req) =>
      req.tenant(async (tx) => {
        const me = requireUser(req);
        const q = req.query.search;
        const match = q
          ? or(
              ilike(users.firstName, `%${likeEscape(q)}%`),
              ilike(users.lastName, `%${likeEscape(q)}%`),
              ilike(sql`${users.firstName} || ' ' || ${users.lastName}`, `%${likeEscape(q)}%`),
            )
          : undefined;
        const base = and(ne(users.id, me.id), eq(users.status, "active"), isNull(users.deletedAt), match);
        let rows: { id: string; firstName: string; lastName: string }[];
        if (await canMessageAnyone(tx, req)) {
          rows = await tx
            .select({ id: users.id, firstName: users.firstName, lastName: users.lastName })
            .from(users)
            .where(base)
            .orderBy(asc(users.firstName), asc(users.lastName))
            .limit(req.query.limit);
        } else {
          const courseIds = await messagingCourseIds(tx, req);
          if (!courseIds.length) return [];
          rows = await tx
            .selectDistinct({ id: users.id, firstName: users.firstName, lastName: users.lastName })
            .from(enrolments)
            .innerJoin(users, eq(users.id, enrolments.userId))
            .where(and(inArray(enrolments.courseId, courseIds), eq(enrolments.status, "active"), base))
            .orderBy(asc(users.firstName), asc(users.lastName), asc(users.id))
            .limit(req.query.limit);
        }
        const blocks = rows.length
          ? await tx
              .select({ id: userBlocks.blockedUserId })
              .from(userBlocks)
              .where(and(eq(userBlocks.userId, me.id), inArray(userBlocks.blockedUserId, rows.map((r) => r.id))))
          : [];
        const blocked = new Set(blocks.map((b) => b.id));
        return rows.map((r) => ({ ...r, blocked: blocked.has(r.id) }));
      }),
  );

  app.get(
    "/blocks",
    { schema: { tags: ["Messaging"], summary: "Users I blocked", response: { 200: z.array(zPerson) } } },
    (req) =>
      req.tenant(async (tx) => {
        const me = requireUser(req);
        return tx
          .select({ id: users.id, firstName: users.firstName, lastName: users.lastName })
          .from(userBlocks)
          .innerJoin(users, eq(users.id, userBlocks.blockedUserId))
          .where(eq(userBlocks.userId, me.id));
      }),
  );

  app.post(
    "/blocks",
    { schema: { tags: ["Messaging"], summary: "Block a user from messaging me", body: z.object({ userId: zId }), response: { 200: zOk } } },
    (req) =>
      req.tenant(async (tx) => {
        const me = requireUser(req);
        if (req.body.userId === me.id) throw badRequest("You cannot block yourself");
        must((await tx.select({ id: users.id }).from(users).where(eq(users.id, req.body.userId)).limit(1))[0], "User");
        await tx.insert(userBlocks).values({ organizationId: req.org.id, userId: me.id, blockedUserId: req.body.userId }).onConflictDoNothing();
        return ok;
      }),
  );

  app.delete(
    "/blocks/:userId",
    { schema: { tags: ["Messaging"], summary: "Unblock a user", params: z.object({ userId: zId }), response: { 200: zOk } } },
    (req) =>
      req.tenant(async (tx) => {
        const me = requireUser(req);
        await tx.delete(userBlocks).where(and(eq(userBlocks.userId, me.id), eq(userBlocks.blockedUserId, req.params.userId)));
        return ok;
      }),
  );
};
