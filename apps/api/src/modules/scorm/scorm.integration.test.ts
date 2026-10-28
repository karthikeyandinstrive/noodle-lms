import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crc32 } from "../interactive/zip";

/** End-to-end SCORM flow against the in-process API (in-memory PGlite, local storage in a temp dir). */
const storageDir = mkdtempSync(path.join(tmpdir(), "lms-scorm-test-"));
process.env.STORAGE_LOCAL_DIR = storageDir;

type Helpers = typeof import("../../../test/helpers");
let h: Helpers;
let env: Awaited<ReturnType<Helpers["setup"]>>;
let admin: InstanceType<Helpers["Client"]>;
let student: InstanceType<Helpers["Client"]>;
let other: InstanceType<Helpers["Client"]>;
let courseId: string;
let activityId: string;

const MANIFEST = `<?xml version="1.0"?>
<manifest identifier="m1" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2">
  <metadata><schemaversion>1.2</schemaversion></metadata>
  <organizations default="o"><organization identifier="o"><title>Course</title>
    <item identifier="i" identifierref="r"><title>SCO</title><adlcp:masteryscore>70</adlcp:masteryscore></item>
  </organization></organizations>
  <resources><resource identifier="r" type="webcontent" adlcp:scormtype="sco" href="sco/index.html"/></resources>
</manifest>`;

function storedZip(entries: { name: string; data: string }[]) {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = Buffer.from(e.data);
    const name = Buffer.from(e.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt32LE(crc32(data), 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, eocd]);
}

async function upload(client: InstanceType<Helpers["Client"]>, filename: string, body: Buffer) {
  const start = await client.req("POST", "/files/uploads", { component: "draft", area: "draft", filename, mimeType: "application/zip", size: body.length });
  expect(start.status).toBe(201);
  const put = await env.app.inject({ method: "PUT", url: start.body.uploadUrl, headers: { host: "localhost", "content-type": "application/zip" }, payload: body });
  expect(put.statusCode).toBe(200);
  const done = await client.req("POST", `/files/${start.body.file.id}/complete`, {});
  expect(done.status).toBe(200);
  return start.body.file.id as string;
}

beforeAll(async () => {
  h = await import("../../../test/helpers");
  env = await h.setup();
  admin = new h.Client(env.app);
  expect((await admin.login("admin@default.test")).status).toBe(200);
  for (const email of ["scorm-a@default.test", "scorm-b@default.test"]) {
    await admin.req("POST", "/users", { email, firstName: "S", lastName: email[6]!, password: h.PASSWORD });
  }
  student = new h.Client(env.app);
  other = new h.Client(env.app);
  await student.login("scorm-a@default.test");
  await other.login("scorm-b@default.test");
  courseId = (await admin.req("POST", "/courses", { fullname: "SCORM", shortname: "SC1", selfEnrol: "open" })).body.id;
  await student.req("POST", `/courses/${courseId}/enrol`, {});
  await other.req("POST", `/courses/${courseId}/enrol`, {});
});

afterAll(async () => {
  await env?.app.close();
  const { closeDb } = await import("@lms/db");
  await closeDb();
  rmSync(storageDir, { recursive: true, force: true });
});

describe("SCORM", () => {
  it("rejects invalid packages and installs a valid one", async () => {
    const overview = await admin.req("GET", `/courses/${courseId}`);
    const sectionId = overview.body.sections[0].id;
    const bad = await upload(admin, "bad.zip", storedZip([{ name: "index.html", data: "x" }]));
    const r1 = await admin.req("POST", `/courses/${courseId}/activities`, { type: "scorm", sectionId, name: "Bad", settings: { packageFileId: bad } });
    expect(r1.status).toBe(400);
    expect(r1.body.error.message).toMatch(/imsmanifest/);

    const fileId = await upload(
      admin,
      "course.zip",
      storedZip([
        { name: "imsmanifest.xml", data: MANIFEST },
        { name: "sco/index.html", data: "<html><script>parent.API</script></html>" },
      ]),
    );
    const res = await admin.req("POST", `/courses/${courseId}/activities`, {
      type: "scorm",
      sectionId,
      name: "Golf",
      settings: { packageFileId: fileId, gradeMax: 50, maxAttempts: 2 },
    });
    expect(res.status).toBe(201);
    activityId = res.body.id;
    expect(res.body.settings).toMatchObject({ version: "1.2", gradeMax: 50, maxAttempts: 2, multiSco: false });
  });

  let attemptId: string;
  let contentUrl: string;

  it("starts an attempt with the initial CMI and serves content same-origin", async () => {
    const res = await student.req("POST", `/scorm/${activityId}/attempts`, {});
    expect(res.status).toBe(200);
    attemptId = res.body.attemptId;
    contentUrl = res.body.contentUrl;
    expect(res.body.cmi).toMatchObject({ "cmi.core.entry": "ab-initio", "cmi.core.lesson_status": "not attempted", "cmi.core.credit": "credit", "cmi.student_data.mastery_score": "70" });
    expect(contentUrl).toMatch(new RegExp(`^/api/v1/scorm/${activityId}/content/[^/]+/sco/index.html$`));

    const file = await env.app.inject({ method: "GET", url: contentUrl, headers: { host: "localhost", cookie: student.cookie } });
    expect(file.statusCode).toBe(200);
    expect(file.headers["content-type"]).toContain("text/html");
    expect(file.headers["x-content-type-options"]).toBe("nosniff");
    expect(file.headers["content-security-policy"]).toContain("frame-ancestors 'self'");
    // Another signed-in user cannot reuse the token.
    expect((await env.app.inject({ method: "GET", url: contentUrl, headers: { host: "localhost", cookie: other.cookie } })).statusCode).toBe(404);
    const traversal = contentUrl.replace("sco/index.html", "..%2F..%2Fimsmanifest.xml");
    expect((await env.app.inject({ method: "GET", url: traversal, headers: { host: "localhost" } })).statusCode).toBe(404);
  });

  it("commits CMI, validates it, computes status/score/time and grades", async () => {
    const res = await student.req("PUT", `/scorm/${activityId}/attempts/${attemptId}/commit`, {
      cmi: {
        "cmi.core.lesson_status": "completed",
        "cmi.core.score.raw": "80",
        "cmi.core.session_time": "0000:05:00",
        "cmi.core.exit": "suspend",
        "cmi.suspend_data": "abc",
        "cmi.core.student_id": "forged",
        "cmi.core.lesson_location": "x".repeat(300),
      },
      finish: true,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "passed", scoreRaw: 80, scoreMax: 100, totalTimeSeconds: 300 });
    expect(res.body.rejected.map((r: { key: string }) => r.key).sort()).toEqual(["cmi.core.lesson_location", "cmi.core.student_id"]);

    // IDOR: another learner cannot write this attempt.
    expect((await other.req("PUT", `/scorm/${activityId}/attempts/${attemptId}/commit`, { cmi: {} })).status).toBe(404);

    const me = await student.req("GET", `/scorm/${activityId}/attempts/me`);
    expect(me.body).toMatchObject({ gradePercent: 80, canStartNew: true, maxAttempts: 2 });

    const resume = await student.req("POST", `/scorm/${activityId}/attempts`, {});
    expect(resume.body.attemptId).toBe(attemptId);
    expect(resume.body.cmi).toMatchObject({ "cmi.core.entry": "resume", "cmi.suspend_data": "abc", "cmi.core.total_time": "0000:05:00.00" });

    const second = await student.req("POST", `/scorm/${activityId}/attempts`, { newAttempt: true });
    expect(second.body.attempt).toBe(2);
    await student.req("PUT", `/scorm/${activityId}/attempts/${second.body.attemptId}/commit`, { cmi: { "cmi.core.lesson_status": "failed", "cmi.core.score.raw": "40" }, finish: true });
    expect((await student.req("POST", `/scorm/${activityId}/attempts`, { newAttempt: true })).status).toBe(409);
    // Older attempts are read-only.
    expect((await student.req("PUT", `/scorm/${activityId}/attempts/${attemptId}/commit`, { cmi: {} })).status).toBe(409);

    const { systemDb, gradeGrades, gradeItems } = await import("@lms/db");
    const { eq } = await import("drizzle-orm");
    const db = await systemDb();
    const [row] = await db.select({ g: gradeGrades.finalGrade }).from(gradeGrades).innerJoin(gradeItems, eq(gradeItems.id, gradeGrades.itemId)).where(eq(gradeItems.activityId, activityId));
    expect(row?.g).toBe(40); // highest of 80% and 40% of 50
  });

  it("shows the report to teachers only", async () => {
    expect((await student.req("GET", `/scorm/${activityId}/report`)).status).toBe(403);
    const res = await admin.req("GET", `/scorm/${activityId}/report`);
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ attempts: 2, status: "failed", gradePercent: 80 });
  });
});

describe("package replacement", () => {
  it("deletes the old package's extracted files after a new package is installed", async () => {
    const { existsSync } = await import("node:fs");
    const { eq } = await import("drizzle-orm");
    const { scormPackages, systemDb } = await import("@lms/db");
    const { runDueJobs } = await import("../../core/jobs");
    const prefixOf = async () => (await (await systemDb()).select().from(scormPackages).where(eq(scormPackages.activityId, activityId)))[0]!.storagePrefix;

    const oldPrefix = await prefixOf();
    expect(existsSync(path.join(storageDir, oldPrefix, "sco/index.html"))).toBe(true);
    const fileId = await upload(
      admin,
      "golf-v2.zip",
      storedZip([
        { name: "imsmanifest.xml", data: MANIFEST },
        { name: "sco/index.html", data: "<html>v2</html>" },
      ]),
    );
    expect((await admin.req("PATCH", `/activities/${activityId}`, { settings: { packageFileId: fileId } })).status).toBe(200);
    const newPrefix = await prefixOf();
    expect(newPrefix).not.toBe(oldPrefix);

    while ((await runDueJobs(50)) > 0);
    expect(existsSync(path.join(storageDir, oldPrefix))).toBe(false);
    expect(existsSync(path.join(storageDir, newPrefix, "sco/index.html"))).toBe(true);
  });
});
