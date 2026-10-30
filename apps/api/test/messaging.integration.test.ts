import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDb, notifications, systemDb, withTenant } from "@lms/db";
import { dispatchPendingEvents } from "../src/core/events";
import { subscribeLive, type LiveEvent } from "../src/core/live";
import { notify } from "../src/core/notify";
import { Client, PASSWORD, setup, type TestEnv } from "./helpers";

/**
 * Messaging permissions: who may message whom (shared courses, send_any),
 * blocks, members-only access (IDOR), debounced notifications, and search scoping.
 */
let env: TestEnv;
let admin: Client;
let s1: Client;
let s2: Client;
let s3: Client;
const ids = {} as { admin: string; s1: string; s2: string; s3: string };
let courseId: string;
let conversationId: string;
let messageId: string;

async function user(email: string, first: string) {
  const res = await admin.req("POST", "/users", { email, firstName: first, lastName: "Test", password: PASSWORD });
  expect(res.status).toBe(201);
  const c = new Client(env.app);
  expect((await c.login(email)).status).toBe(200);
  return { client: c, id: res.body.id as string };
}

async function messageNotifications(userId: string) {
  const db = await systemDb();
  return db.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.type, "message")));
}

beforeAll(async () => {
  env = await setup();
  admin = new Client(env.app);
  expect((await admin.login("admin@default.test")).status).toBe(200);
  ids.admin = (await admin.req("GET", "/auth/me")).body.user.id;
  ({ client: s1, id: ids.s1 } = await user("alice@default.test", "Alice"));
  ({ client: s2, id: ids.s2 } = await user("bob@default.test", "Bob"));
  ({ client: s3, id: ids.s3 } = await user("carol@default.test", "Carol"));

  const course = await admin.req("POST", "/courses", { fullname: "Biology", shortname: "BIO", selfEnrol: "open" });
  courseId = course.body.id;
  expect((await s1.req("POST", `/courses/${courseId}/enrol`, {})).status).toBe(200);
  expect((await s2.req("POST", `/courses/${courseId}/enrol`, {})).status).toBe(200);
  // s3 shares no course with anyone.
});

afterAll(async () => {
  await env.app.close();
  await closeDb();
});

describe("who may message whom", () => {
  it("lists only people who share a course as contacts", async () => {
    const res = await s1.req("GET", "/messages/contacts");
    expect(res.status).toBe(200);
    const contactIds = res.body.map((u: { id: string }) => u.id);
    expect(contactIds).toContain(ids.s2);
    expect(contactIds).not.toContain(ids.s3);
    const search = await s1.req("GET", "/messages/contacts?search=bo");
    expect(search.body.map((u: { id: string }) => u.id)).toEqual([ids.s2]);
  });

  it("cannot message someone outside shared courses", async () => {
    expect((await s1.req("POST", "/messages/conversations", { type: "direct", userId: ids.s3 })).status).toBe(403);
    expect((await s1.req("POST", "/messages/conversations", { type: "group", name: "G", userIds: [ids.s2, ids.s3] })).status).toBe(403);
    expect((await s1.req("POST", "/messages/conversations", { type: "direct", userId: ids.s1 })).status).toBe(400);
  });

  it("finds or creates the single direct conversation", async () => {
    const a = await s1.req("POST", "/messages/conversations", { type: "direct", userId: ids.s2 });
    expect(a.status).toBe(200);
    conversationId = a.body.id;
    expect(a.body.otherUser.id).toBe(ids.s2);
    const b = await s2.req("POST", "/messages/conversations", { type: "direct", userId: ids.s1 });
    expect(b.body.id).toBe(conversationId);
  });

  it("sends, sanitizes and counts unread messages", async () => {
    const sent = await s1.req("POST", `/messages/conversations/${conversationId}/messages`, { body: "Hello Bob <script>alert(1)</script>photosynthesis" });
    expect(sent.status).toBe(201);
    messageId = sent.body.id;
    expect(sent.body.body).not.toContain("<script>");
    expect((await s1.req("POST", `/messages/conversations/${conversationId}/messages`, { body: "x".repeat(10_001) })).status).toBe(400);

    const list = await s2.req("GET", "/messages/conversations");
    const conv = list.body.find((c: { id: string }) => c.id === conversationId);
    expect(conv.unread).toBe(1);
    expect(conv.lastMessage.preview).toContain("Hello Bob");
    expect((await s2.req("GET", "/messages/unread-count")).body.count).toBe(1);

    const msgs = await s2.req("GET", `/messages/conversations/${conversationId}/messages`);
    expect(msgs.body.items[0]).toMatchObject({ id: messageId, mine: false, canEdit: false });

    expect((await s2.req("POST", `/messages/conversations/${conversationId}/read`, {})).status).toBe(200);
    expect((await s2.req("GET", "/messages/unread-count")).body.count).toBe(0);
  });

  it("lets staff with message:send_any message anyone, and the recipient reply", async () => {
    const conv = await admin.req("POST", "/messages/conversations", { type: "direct", userId: ids.s3 });
    expect(conv.status).toBe(200);
    expect((await admin.req("POST", `/messages/conversations/${conv.body.id}/messages`, { body: "Welcome" })).status).toBe(201);
    expect((await s3.req("POST", `/messages/conversations/${conv.body.id}/messages`, { body: "Thanks" })).status).toBe(201);
  });
});

describe("members-only access (IDOR)", () => {
  it("hides conversations and messages from non-members", async () => {
    expect((await s3.req("GET", `/messages/conversations/${conversationId}`)).status).toBe(404);
    expect((await s3.req("GET", `/messages/conversations/${conversationId}/messages`)).status).toBe(404);
    expect((await s3.req("POST", `/messages/conversations/${conversationId}/messages`, { body: "intrude" })).status).toBe(404);
    expect((await s3.req("POST", `/messages/conversations/${conversationId}/read`, {})).status).toBe(404);
    expect((await s3.req("PATCH", `/messages/${messageId}`, { body: "hacked" })).status).toBe(404);
    expect((await s3.req("DELETE", `/messages/${messageId}`)).status).toBe(404);
    expect((await s3.req("GET", "/messages/conversations")).body.some((c: { id: string }) => c.id === conversationId)).toBe(false);
  });

  it("only the author can edit or delete a message", async () => {
    expect((await s2.req("PATCH", `/messages/${messageId}`, { body: "not mine" })).status).toBe(403);
    const edited = await s1.req("PATCH", `/messages/${messageId}`, { body: "Hello Bob, photosynthesis question" });
    expect(edited.status).toBe(200);
    expect(edited.body.body).toBe("Hello Bob, photosynthesis question");
  });

  it("scopes message search to my conversations", async () => {
    const mine = await s1.req("GET", "/search?q=photosynthesis&types=messages");
    expect(mine.status).toBe(200);
    expect(mine.body.groups[0].items.map((i: { id: string }) => i.id)).toContain(messageId);
    const other = await s3.req("GET", "/search?q=photosynthesis&types=messages");
    expect(other.body.groups[0].items).toHaveLength(0);
    // Users are only searchable with user:view.
    expect((await s1.req("GET", "/search?q=carol&types=users")).body.groups[0].items).toHaveLength(0);
    expect((await admin.req("GET", "/search?q=carol&types=users")).body.groups[0].items).toHaveLength(1);
  });
});

describe("blocking", () => {
  it("refuses messages from a blocked sender until unblocked", async () => {
    expect((await s2.req("POST", "/messages/blocks", { userId: ids.s1 })).status).toBe(200);
    expect((await s1.req("POST", `/messages/conversations/${conversationId}/messages`, { body: "are you there?" })).status).toBe(403);
    expect((await s1.req("POST", "/messages/conversations", { type: "direct", userId: ids.s2 })).status).toBe(403);
    const contacts = await s2.req("GET", "/messages/contacts");
    expect(contacts.body.find((u: { id: string }) => u.id === ids.s1).blocked).toBe(true);
    // The blocker can't write to the person they blocked either.
    expect((await s2.req("POST", `/messages/conversations/${conversationId}/messages`, { body: "hm" })).status).toBe(403);

    expect((await s2.req("DELETE", `/messages/blocks/${ids.s1}`)).status).toBe(200);
    expect((await s1.req("POST", `/messages/conversations/${conversationId}/messages`, { body: "back again" })).status).toBe(201);
  });
});

describe("group and course conversations", () => {
  it("creates a group with people I may message", async () => {
    const g = await s1.req("POST", "/messages/conversations", { type: "group", name: "Study group", userIds: [ids.s2] });
    expect(g.status).toBe(200);
    expect(g.body.members.map((m: { id: string }) => m.id).sort()).toEqual([ids.s1, ids.s2].sort());
    expect((await s2.req("POST", `/messages/conversations/${g.body.id}/members`, { userIds: [ids.s3] })).status).toBe(403);
  });

  it("only staff start the course conversation; participants join it", async () => {
    expect((await s1.req("POST", "/messages/conversations", { type: "course", courseId })).status).toBe(403);
    const c = await admin.req("POST", "/messages/conversations", { type: "course", courseId });
    expect(c.status).toBe(200);
    const memberIds = c.body.members.map((m: { id: string }) => m.id);
    expect(memberIds).toEqual(expect.arrayContaining([ids.s1, ids.s2, ids.admin]));
    expect(memberIds).not.toContain(ids.s3);
    expect((await s1.req("POST", `/messages/conversations/${c.body.id}/messages`, { body: "Hi class" })).status).toBe(201);
    expect((await s3.req("GET", `/messages/conversations/${c.body.id}/messages`)).status).toBe(404);
  });
});

describe("notifications", () => {
  it("notifies once per conversation until read (debounced), and respects mute", async () => {
    const conv = await s1.req("POST", "/messages/conversations", { type: "group", name: "Notify test", userIds: [ids.s2] });
    while ((await dispatchPendingEvents(100)) > 0); // earlier tests' events
    const before = (await messageNotifications(ids.s2)).length;
    await s1.req("POST", `/messages/conversations/${conv.body.id}/messages`, { body: "one" });
    await s1.req("POST", `/messages/conversations/${conv.body.id}/messages`, { body: "two" });
    while ((await dispatchPendingEvents(100)) > 0);
    const after = await messageNotifications(ids.s2);
    expect(after.length - before).toBe(1);
    expect(after.some((n) => n.link === `/messages?c=${conv.body.id}`)).toBe(true);

    // Muted conversations never notify.
    expect((await s2.req("PUT", `/messages/conversations/${conv.body.id}/mute`, { muted: true })).status).toBe(200);
    await s2.req("POST", `/messages/conversations/${conv.body.id}/read`, {});
    const db = await systemDb();
    await db.update(notifications).set({ readAt: new Date() }).where(eq(notifications.userId, ids.s2));
    await s1.req("POST", `/messages/conversations/${conv.body.id}/messages`, { body: "three" });
    while ((await dispatchPendingEvents(100)) > 0);
    expect((await messageNotifications(ids.s2)).length).toBe(after.length);
    const list = await s2.req("GET", "/messages/conversations");
    expect(list.body.find((c: { id: string }) => c.id === conv.body.id).muted).toBe(true);
  });
});

describe("global search", () => {
  it("respects course enrolment and activity visibility", async () => {
    const sectionId = (await admin.req("GET", `/courses/${courseId}`)).body.sections[0].id;
    const visible = await admin.req("POST", `/courses/${courseId}/activities`, { type: "page", sectionId, name: "Mitochondria notes", settings: { content: "<p>Powerhouse of the cell</p>" } });
    const hidden = await admin.req("POST", `/courses/${courseId}/activities`, { type: "page", sectionId, name: "Mitochondria answers", visible: false, settings: { content: "<p>secret</p>" } });
    expect(visible.status).toBe(201);
    const idsOf = (res: { body: { groups: { type: string; items: { id: string }[] }[] } }, type: string) =>
      res.body.groups.find((g) => g.type === type)!.items.map((i) => i.id);

    const learner = await s1.req("GET", "/search?q=mitochondria");
    expect(learner.status, JSON.stringify(learner.body)).toBe(200);
    expect(idsOf(learner, "activities")).toEqual([visible.body.id]);
    const staff = await admin.req("GET", "/search?q=mitochondria&types=activities");
    expect(idsOf(staff, "activities").sort()).toEqual([visible.body.id, hidden.body.id].sort());
    const outsider = await s3.req("GET", "/search?q=mitochondria");
    expect(idsOf(outsider, "activities")).toEqual([]);
    // Visible courses are findable by anyone (catalog), including prefix matches.
    expect(idsOf(await s3.req("GET", "/search?q=Biol&types=courses"), "courses")).toEqual([courseId]);
    // LIKE wildcards are escaped.
    const pct = await s3.req("GET", "/search?q=%25&types=courses");
    expect(pct.status, JSON.stringify(pct.body)).toBe(200);
    expect(idsOf(pct, "courses")).toEqual([]);
    expect((await new Client(env.app).req("GET", "/search?q=x")).status).toBe(401);
  });
});

describe("live updates (server-sent events)", () => {
  it("streams a hint to conversation members when a message arrives, and requires sign-in", async () => {
    const http = await import("node:http");
    await env.app.listen({ port: 0, host: "127.0.0.1" });
    const port = (env.app.server.address() as import("node:net").AddressInfo).port;
    const open = (cookie?: string) =>
      new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
        http.get({ host: "127.0.0.1", port, path: "/api/v1/messages/stream", headers: { host: "localhost", ...(cookie ? { cookie } : {}) } }, resolve).on("error", reject);
      });

    expect((await open()).statusCode).toBe(401);

    const res = await open(s2.cookie);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    let buffer = "";
    const got = new Promise<string>((resolve) => {
      res.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        if (buffer.includes("event: message")) resolve(buffer);
      });
    });
    expect((await s1.req("POST", `/messages/conversations/${conversationId}/messages`, { body: "Are you there?" })).status).toBe(201);
    const text = await Promise.race([got, new Promise<string>((_, reject) => setTimeout(() => reject(new Error(`no event: ${buffer}`)), 5000))]);
    expect(text).toContain(`"conversationId":"${conversationId}"`);
    // Hints only: the message text never travels over the stream.
    expect(text).not.toContain("Are you there?");
    res.destroy();
  });
});

describe("live notification hints", () => {
  async function orgId() {
    return (await admin.req("GET", "/auth/me")).body.organization.id as string;
  }

  it("tells the recipient's tabs after the notification commits, and never on rollback", async () => {
    const organizationId = await orgId();
    const events: LiveEvent[] = [];
    const stop = subscribeLive(ids.s3, (e) => events.push(e));
    try {
      await expect(
        withTenant(organizationId, async (tx) => {
          await notify(tx, { organizationId, userIds: [ids.s3], type: "announcement", title: "Rolled back" });
          throw new Error("abort");
        }),
      ).rejects.toThrow("abort");
      await new Promise((r) => setTimeout(r, 20));
      expect(events).toEqual([]);

      await withTenant(organizationId, async (tx) => {
        await notify(tx, { organizationId, userIds: [ids.s3], type: "announcement", title: "Hello" });
        // Not before commit.
        expect(events).toEqual([]);
      });
      expect(events).toEqual([{ type: "notification" }]);

      // Marking read updates the badge in the user's other tabs.
      expect((await s3.req("POST", "/notifications/read", { all: true })).status).toBe(200);
      expect(events).toHaveLength(2);
      // Nothing left to mark: no hint.
      expect((await s3.req("POST", "/notifications/read", { all: true })).status).toBe(200);
      expect(events).toHaveLength(2);
    } finally {
      stop();
    }
  });
});
