/** Shapes returned by /api/v1/messages (mirror apps/api modules/messaging/routes.ts). */

export type Person = { id: string; firstName: string; lastName: string };

export type Conversation = {
  id: string;
  type: "direct" | "group" | "course";
  name: string | null;
  courseId: string | null;
  createdBy: string | null;
  lastMessageAt: string | null;
  createdAt: string;
  members: Person[];
  otherUser: Person | null;
  blocked: boolean;
  muted: boolean;
  unread: number;
  lastReadAt: string | null;
  lastMessage: { id: string; userId: string; preview: string; createdAt: string; deleted: boolean } | null;
  canPost: boolean;
};

export type Message = {
  id: string;
  conversationId: string;
  user: Person;
  body: string;
  createdAt: string;
  updatedAt: string;
  edited: boolean;
  deleted: boolean;
  mine: boolean;
  canEdit: boolean;
};

export type Contact = Person & { blocked: boolean };

export const messagingKeys = {
  all: ["messages"] as const,
  conversations: ["messages", "conversations"] as const,
  thread: (id: string) => ["messages", "thread", id] as const,
  unread: ["messages", "unread-count"] as const,
  contacts: (search: string) => ["messages", "contacts", search] as const,
};

export function conversationTitle(c: Conversation, fallback: string) {
  if (c.type === "direct") return c.otherUser ? `${c.otherUser.firstName} ${c.otherUser.lastName}` : fallback;
  return c.name ?? fallback;
}

export function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}
