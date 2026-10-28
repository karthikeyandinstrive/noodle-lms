import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import {
  conversationMembers,
  conversations,
  courses,
  enrolments,
  getSystemContext,
  messages,
  userBlocks,
  users,
  type DB,
} from "@lms/db";
import { requireUser } from "../../core/auth";
import { forbidden, must, notFound } from "../../core/errors";
import { hasCapability } from "../../core/rbac";

export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;

/** Messages can be edited or deleted by their author for this long. */
export const EDIT_WINDOW_MS = 15 * 60 * 1000;
/** Max length of a message body (before sanitizing). */
export const MAX_BODY = 10_000;
/** A recipient who read the conversation this recently is not notified again. */
export const NOTIFY_QUIET_MS = 5 * 60 * 1000;

export const conversationLink = (conversationId: string) => `/messages?c=${conversationId}`;

export function directKeyFor(a: string, b: string) {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/** Escapes LIKE wildcards in user input. */
export function likeEscape(value: string) {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/** Plain-text preview of a sanitized message body. */
export function plainPreview(html: string, max = 140) {
  const text = html
    .replace(/<(br|\/p|\/div|\/li|\/h\d)[^>]*>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

async function systemContextId(tx: DB, req: FastifyRequest) {
  return (await getSystemContext(tx, req.org.id)).id;
}

export async function canMessageAnyone(tx: DB, req: FastifyRequest) {
  return hasCapability(tx, req, "message:send_any", await systemContextId(tx, req));
}

/**
 * Course ids (active enrolment) where the current user holds message:send.
 * The capability is checked in each course context, so a system-level grant
 * or a course-level override both apply.
 */
export async function messagingCourseIds(tx: DB, req: FastifyRequest) {
  const me = requireUser(req);
  const rows = await tx
    .select({ id: courses.id, contextId: courses.contextId })
    .from(enrolments)
    .innerJoin(courses, eq(courses.id, enrolments.courseId))
    .where(and(eq(enrolments.userId, me.id), eq(enrolments.status, "active")));
  const out: string[] = [];
  for (const r of rows) if (await hasCapability(tx, req, "message:send", r.contextId)) out.push(r.id);
  return out;
}

/** Whether the current user holds message:send anywhere (system, or one of their courses). */
export async function canSendAtAll(tx: DB, req: FastifyRequest) {
  const sys = await systemContextId(tx, req);
  if ((await hasCapability(tx, req, "message:send_any", sys)) || (await hasCapability(tx, req, "message:send", sys))) return true;
  return (await messagingCourseIds(tx, req)).length > 0;
}

/**
 * Who may start a conversation with whom:
 *  - message:send_any (system) → any active user of the organization;
 *  - message:send → users who share an active course with the sender, where the
 *    sender holds message:send in that course's context.
 */
export async function canMessage(tx: DB, req: FastifyRequest, recipientId: string) {
  const me = requireUser(req);
  if (recipientId === me.id) return false;
  const [recipient] = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, recipientId), eq(users.status, "active"), isNull(users.deletedAt)))
    .limit(1);
  if (!recipient) return false;
  if (await canMessageAnyone(tx, req)) return true;
  const courseIds = await messagingCourseIds(tx, req);
  if (!courseIds.length) return false;
  const [shared] = await tx
    .select({ id: enrolments.id })
    .from(enrolments)
    .where(and(eq(enrolments.userId, recipientId), eq(enrolments.status, "active"), inArray(enrolments.courseId, courseIds)))
    .limit(1);
  return !!shared;
}

/** True when `userId` has blocked `blockedUserId`. */
export async function hasBlocked(tx: DB, userId: string, blockedUserId: string) {
  const [row] = await tx
    .select({ id: userBlocks.id })
    .from(userBlocks)
    .where(and(eq(userBlocks.userId, userId), eq(userBlocks.blockedUserId, blockedUserId)))
    .limit(1);
  return !!row;
}

/** Throws unless the current user may message `recipientId` (permission + not blocked by them). */
export async function assertCanMessage(tx: DB, req: FastifyRequest, recipientId: string) {
  const me = requireUser(req);
  if (!(await canMessage(tx, req, recipientId))) throw forbidden("You cannot message this user");
  if (await hasBlocked(tx, recipientId, me.id)) throw forbidden("This user is not accepting messages from you");
}

/**
 * Loads a conversation the current user is a member of. Non-members get 404
 * (IDOR: conversation ids never reveal anything to outsiders).
 */
export async function loadConversation(tx: DB, req: FastifyRequest, conversationId: string) {
  const me = requireUser(req);
  const [row] = await tx
    .select({ conversation: conversations, member: conversationMembers })
    .from(conversations)
    .innerJoin(
      conversationMembers,
      and(eq(conversationMembers.conversationId, conversations.id), eq(conversationMembers.userId, me.id)),
    )
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!row) throw notFound("Conversation");
  return row;
}

export async function memberIds(tx: DB, conversationId: string) {
  return (
    await tx.select({ userId: conversationMembers.userId }).from(conversationMembers).where(eq(conversationMembers.conversationId, conversationId))
  ).map((r) => r.userId);
}

export async function addMembers(tx: DB, conversation: Pick<ConversationRow, "id" | "organizationId">, userIds: string[]) {
  const ids = [...new Set(userIds)];
  if (!ids.length) return;
  await tx
    .insert(conversationMembers)
    .values(ids.map((userId) => ({ organizationId: conversation.organizationId, conversationId: conversation.id, userId })))
    .onConflictDoNothing();
}

/** Finds (or creates) the single direct conversation between two users. */
export async function findOrCreateDirect(tx: DB, organizationId: string, me: string, other: string) {
  const key = directKeyFor(me, other);
  const [existing] = await tx
    .select()
    .from(conversations)
    .where(and(eq(conversations.type, "direct"), eq(conversations.directKey, key)))
    .limit(1);
  if (existing) {
    await addMembers(tx, existing, [me, other]);
    return { conversation: existing, created: false };
  }
  const [created] = await tx
    .insert(conversations)
    .values({ organizationId, type: "direct", directKey: key, createdBy: me })
    .onConflictDoNothing()
    .returning();
  const conv =
    created ??
    must((await tx.select().from(conversations).where(and(eq(conversations.type, "direct"), eq(conversations.directKey, key))).limit(1))[0]);
  await addMembers(tx, conv, [me, other]);
  return { conversation: conv, created: !!created };
}

export async function activeCourseUserIds(tx: DB, courseId: string) {
  return (
    await tx
      .select({ userId: enrolments.userId })
      .from(enrolments)
      .innerJoin(users, eq(users.id, enrolments.userId))
      .where(and(eq(enrolments.courseId, courseId), eq(enrolments.status, "active"), eq(users.status, "active")))
  ).map((r) => r.userId);
}

export async function courseConversation(tx: DB, courseId: string) {
  const [row] = await tx
    .select()
    .from(conversations)
    .where(and(eq(conversations.type, "course"), eq(conversations.courseId, courseId), isNull(conversations.groupId)))
    .limit(1);
  return row ?? null;
}

/** Number of unread messages per conversation for a user (others' live messages after lastReadAt). */
export async function unreadCounts(tx: DB, userId: string, conversationIds?: string[]) {
  if (conversationIds && !conversationIds.length) return new Map<string, number>();
  const rows = await tx
    .select({ conversationId: messages.conversationId, count: sql<number>`count(*)::int` })
    .from(messages)
    .innerJoin(
      conversationMembers,
      and(eq(conversationMembers.conversationId, messages.conversationId), eq(conversationMembers.userId, userId)),
    )
    .where(
      and(
        ne(messages.userId, userId),
        isNull(messages.deletedAt),
        sql`(${conversationMembers.lastReadAt} is null or ${messages.createdAt} > ${conversationMembers.lastReadAt})`,
        conversationIds ? inArray(messages.conversationId, conversationIds) : undefined,
      ),
    )
    .groupBy(messages.conversationId);
  return new Map(rows.map((r) => [r.conversationId, Number(r.count)]));
}

export const isMuted = (m: { muted: string | null }) => !!m.muted;
