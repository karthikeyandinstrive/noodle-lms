import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "@lms/db";
import { Client, PASSWORD, setup, type TestEnv } from "./helpers";

let env: TestEnv;
let admin: Client;
let student: Client;
let studentId: string;
let courseId: string;

beforeAll(async () => {
  env = await setup();
  admin = new Client(env.app);
  expect((await admin.login("admin@default.test")).status).toBe(200);

  const created = await admin.req("POST", "/users", { email: "student@default.test", firstName: "Stu", lastName: "Dent", password: PASSWORD });
  expect(created.status).toBe(201);
  studentId = created.body.id;
  student = new Client(env.app);
  expect((await student.login("student@default.test")).status).toBe(200);

  const course = await admin.req("POST", "/courses", { fullname: "Algebra", shortname: "ALG", selfEnrol: "open" });
  expect(course.status).toBe(201);
  courseId = course.body.id;
});

afterAll(async () => {
  await env.app.close();
  await closeDb();
});

describe("authentication", () => {
  it("rejects a wrong password with a generic message", async () => {
    const res = await new Client(env.app).login("admin@default.test", "wrong-password1");
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe("Invalid email or password");
  });

  it("does not reveal whether an account exists", async () => {
    const res = await new Client(env.app).login("nobody@default.test", "wrong-password1");
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe("Invalid email or password");
  });

  it("requires a session for protected routes", async () => {
    const res = await new Client(env.app).req("POST", "/courses", { fullname: "X", shortname: "X" });
    expect(res.status).toBe(401);
  });

  it("blocks cookie-authenticated cross-origin mutations (CSRF)", async () => {
    const res = await admin.req("POST", "/courses", { fullname: "X", shortname: "X" }, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
  });

  it("issues bearer tokens for API clients", async () => {
    const res = await new Client(env.app).req("POST", "/auth/token", { email: "student@default.test", password: PASSWORD });
    expect(res.status).toBe(200);
    const me = await env.app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { host: "localhost", authorization: `Bearer ${res.body.token}` } });
    expect(JSON.parse(me.body).user.id).toBe(studentId);
  });

  it("revokes the session on logout", async () => {
    const c = new Client(env.app);
    await c.login("student@default.test");
    const cookie = c.cookie;
    await c.req("POST", "/auth/logout", {});
    c.cookie = cookie;
    expect((await c.req("GET", "/auth/me")).body.user).toBeNull();
  });
});

describe("RBAC", () => {
  it("students cannot create courses", async () => {
    expect((await student.req("POST", "/courses", { fullname: "Nope", shortname: "NOPE" })).status).toBe(403);
  });

  it("students cannot list users", async () => {
    expect((await student.req("GET", "/users")).status).toBe(403);
  });

  it("a non-enrolled student sees the public preview only", async () => {
    const res = await student.req("GET", `/courses/${courseId}`);
    expect(res.status).toBe(200);
    expect(res.body.capabilities["course:view"]).toBe(false);
    expect(res.body.sections.every((s: { activities: unknown[] }) => s.activities.length === 0)).toBe(true);
  });

  it("self-enrolment grants the student role in the course context", async () => {
    expect((await student.req("POST", `/courses/${courseId}/enrol`, {})).status).toBe(200);
    const res = await student.req("GET", `/courses/${courseId}`);
    expect(res.body.enrolled).toBe(true);
    expect(res.body.capabilities["course:view"]).toBe(true);
    expect(res.body.capabilities["course:update"]).toBe(false);
  });

  it("enrolled students still cannot edit the course or add activities", async () => {
    expect((await student.req("PATCH", `/courses/${courseId}`, { fullname: "Hacked" })).status).toBe(403);
    const overview = await admin.req("GET", `/courses/${courseId}`);
    const sectionId = overview.body.sections[0].id;
    const res = await student.req("POST", `/courses/${courseId}/activities`, { type: "page", sectionId, name: "x", settings: { content: "<p>x</p>" } });
    expect(res.status).toBe(403);
  });

  it("a course-level prohibit override removes access even for enrolled students", async () => {
    const roles = await admin.req<{ id: string; shortname: string }[]>("GET", "/roles");
    const studentRole = roles.body.find((r) => r.shortname === "student")!;
    const overview = await admin.req("GET", `/courses/${courseId}`);
    const contextId = await courseContextId(courseId);
    expect(overview.status).toBe(200);
    expect((await admin.req("PUT", `/contexts/${contextId}/overrides`, { roleId: studentRole.id, capability: "course:view", permission: "prohibit" })).status).toBe(200);
    expect((await student.req("GET", `/courses/${courseId}`)).body.capabilities["course:view"]).toBe(false);
    await admin.req("PUT", `/contexts/${contextId}/overrides`, { roleId: studentRole.id, capability: "course:view", permission: null });
    expect((await student.req("GET", `/courses/${courseId}`)).body.capabilities["course:view"]).toBe(true);
  });
});

describe("partial updates", () => {
  it("PATCH only changes the fields it sends (no defaults re-applied)", async () => {
    const created = await admin.req("POST", "/courses", { fullname: "Patch me", shortname: "PATCH1", selfEnrol: "open", visible: false });
    expect(created.status).toBe(201);
    const patched = await admin.req("PATCH", `/courses/${created.body.id}`, { fullname: "Patched" });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ fullname: "Patched", selfEnrol: "open", visible: false });
  });
});

describe("tenant isolation", () => {
  it("a session from one organization is not valid on another", async () => {
    const other = new Client(env.app, "acme.localhost");
    other.cookie = admin.cookie;
    expect((await other.req("GET", "/auth/me")).body.user).toBeNull();
  });

  it("an organization admin cannot read another organization's course", async () => {
    const acme = new Client(env.app, "acme.localhost");
    await acme.login("admin@acme.test");
    expect((await acme.req("GET", `/courses/${courseId}`)).status).toBe(404);
    const list = await acme.req("GET", "/courses");
    expect(list.body.items.find((c: { id: string }) => c.id === courseId)).toBeUndefined();
  });

  it("users are scoped per organization", async () => {
    const acme = new Client(env.app, "acme.localhost");
    await acme.login("admin@acme.test");
    const users = await acme.req("GET", "/users");
    expect(users.body.items.map((u: { email: string }) => u.email)).toEqual(["admin@acme.test"]);
  });
});

/** Reads the course context through the DB (no public endpoint exposes it to clients that don't need it). */
async function courseContextId(id: string) {
  const { systemDb, courses } = await import("@lms/db");
  const { eq } = await import("drizzle-orm");
  const db = await systemDb();
  const [row] = await db.select({ contextId: courses.contextId }).from(courses).where(eq(courses.id, id));
  return row!.contextId;
}

describe("bulk capability resolution", () => {
  it("prefetchCapabilities gives the same answers as hasCapability", async () => {
    const { withTenant, getSystemContext } = await import("@lms/db");
    const { hasCapability, prefetchCapabilities } = await import("../src/core/rbac");
    const roles = await admin.req<{ id: string; shortname: string }[]>("GET", "/roles");
    const studentRole = roles.body.find((r) => r.shortname === "student")!;

    const other = await admin.req("POST", "/courses", { fullname: "Geometry", shortname: "GEO" });
    const ctxA = await courseContextId(courseId);
    const ctxB = await courseContextId(other.body.id);
    // An allow override in A and a prohibit at a parent-less context B exercise depth handling.
    await admin.req("PUT", `/contexts/${ctxA}/overrides`, { roleId: studentRole.id, capability: "course:update", permission: "allow" });
    await admin.req("PUT", `/contexts/${ctxB}/overrides`, { roleId: studentRole.id, capability: "course:view", permission: "prohibit" });

    const caps = ["course:view", "course:update", "course:view_hidden", "forum:view", "user:view"] as const;
    const orgId = env.orgs.default!.id;
    for (const userId of [studentId, (await admin.req("GET", "/auth/me")).body.user.id as string]) {
      await withTenant(orgId, async (tx) => {
        const sys = (await getSystemContext(tx, orgId)).id;
        const contextIds = [sys, ctxA, ctxB];
        const single = { user: { id: userId } as never, capabilityCache: new Map<string, boolean>() };
        const bulk = { user: { id: userId } as never, capabilityCache: new Map<string, boolean>() };
        await prefetchCapabilities(tx, bulk, [...caps], contextIds);
        for (const ctx of contextIds) {
          for (const cap of caps) {
            expect(bulk.capabilityCache.get(`${cap}@${ctx}`), `${cap}@${ctx} for ${userId}`).toBe(await hasCapability(tx, single, cap, ctx));
          }
        }
      });
    }
    await admin.req("PUT", `/contexts/${ctxA}/overrides`, { roleId: studentRole.id, capability: "course:update", permission: null });
    await admin.req("PUT", `/contexts/${ctxB}/overrides`, { roleId: studentRole.id, capability: "course:view", permission: null });
  });
});
