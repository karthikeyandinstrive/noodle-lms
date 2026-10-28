import { index, pgEnum, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, orgId, ts, updatedAt } from "./_common";
import { organizations, users } from "./core";
import { courses, groups } from "./courses";

export const conversationType = pgEnum("conversation_type", ["direct", "group", "course"]);

export const conversations = pgTable("conversations", {
  id: id(),
  organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
  type: conversationType().notNull(),
  name: text(),
  /** For course / course-group conversations. */
  courseId: uuid().references(() => courses.id, { onDelete: "cascade" }),
  groupId: uuid().references(() => groups.id, { onDelete: "cascade" }),
  /** For direct conversations: "<smallerUserId>:<largerUserId>", unique per org. */
  directKey: text(),
  createdBy: uuid(),
  lastMessageAt: ts(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("conversations_direct_uq").on(t.organizationId, t.directKey)]);

export const conversationMembers = pgTable(
  "conversation_members",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    conversationId: uuid()
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    lastReadAt: ts(),
    muted: text(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("conversation_members_uq").on(t.conversationId, t.userId), index("conversation_members_user_idx").on(t.userId)],
);

export const messages = pgTable(
  "messages",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    conversationId: uuid()
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Sanitized HTML. */
    body: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts(),
  },
  (t) => [index("messages_conversation_idx").on(t.conversationId, t.createdAt)],
);

/** Users a person has blocked from contacting them. */
export const userBlocks = pgTable(
  "user_blocks",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    blockedUserId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("user_blocks_uq").on(t.userId, t.blockedUserId)],
);
