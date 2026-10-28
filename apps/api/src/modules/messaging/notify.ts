import { and, eq, inArray, isNull } from "drizzle-orm";
import { conversationMembers, conversations, messages, notifications, users, type DB } from "@lms/db";
import type { EventMap } from "../../core/events";
import { notify } from "../../core/notify";
import { conversationLink, isMuted, NOTIFY_QUIET_MS, plainPreview } from "./service";

/**
 * Debounced "new message" notifications (subscriber of message.sent).
 * A recipient is skipped when they muted the conversation, read it in the last
 * 5 minutes, or still have an unread "message" notification for it. That last
 * check also makes the handler idempotent when the event is retried.
 */
export async function notifyMessageRecipients(tx: DB, p: EventMap["message.sent"], now = Date.now()) {
  const [msg] = await tx.select().from(messages).where(eq(messages.id, p.messageId)).limit(1);
  if (!msg || msg.deletedAt) return;
  const [conv] = await tx.select().from(conversations).where(eq(conversations.id, p.conversationId)).limit(1);
  if (!conv) return;
  const members = await tx.select().from(conversationMembers).where(eq(conversationMembers.conversationId, conv.id));
  const link = conversationLink(conv.id);
  const candidates = members.filter(
    (m) => m.userId !== msg.userId && !isMuted(m) && !(m.lastReadAt && now - m.lastReadAt.getTime() < NOTIFY_QUIET_MS),
  );
  if (!candidates.length) return;
  const pending = await tx
    .select({ userId: notifications.userId })
    .from(notifications)
    .where(
      and(
        inArray(notifications.userId, candidates.map((m) => m.userId)),
        eq(notifications.type, "message"),
        eq(notifications.link, link),
        isNull(notifications.readAt),
      ),
    );
  const already = new Set(pending.map((r) => r.userId));
  const recipients = candidates.map((m) => m.userId).filter((id) => !already.has(id));
  if (!recipients.length) return;
  const [sender] = await tx.select({ firstName: users.firstName, lastName: users.lastName }).from(users).where(eq(users.id, msg.userId)).limit(1);
  const from = sender ? `${sender.firstName} ${sender.lastName}`.trim() : "Someone";
  await notify(tx, {
    organizationId: p.organizationId,
    userIds: recipients,
    type: "message",
    title: conv.type === "direct" ? `New message from ${from}` : `New message from ${from} in ${conv.name ?? "a conversation"}`,
    body: plainPreview(msg.body, 200),
    link,
  });
}
