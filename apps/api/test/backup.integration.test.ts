import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, gradeItems, systemDb } from "@lms/db";
import { runDueJobs } from "../src/core/jobs";
import { listZip, readZipEntry } from "../src/modules/interactive/zip";
import { Client, ORIGIN, PASSWORD, setup, type TestEnv } from "./helpers";

/**
 * Course backup → restore round-trip into a NEW course (structure, settings,
 * quiz questions preserved; every id remapped), cross-organization restore with
 * enrolments by email, Moodle .mbz import, and permissions.
 */
let env: TestEnv;
let admin: Client;
let student: Client;
let courseId: string;
const act: Record<string, string> = {};
const q: Record<string, string> = {};
let backupFileId: string;

async function upload(c: Client, filename: string, mimeType: string, body: Buffer, host = "localhost") {
  const start = await c.req("POST", "/files/uploads", { component: "draft", area: "draft", filename, mimeType, size: body.length });
  expect(start.status).toBe(201);
  const put = await env.app.inject({ method: "PUT", url: start.body.uploadUrl, headers: { host, origin: ORIGIN, "content-type": mimeType, cookie: c.cookie }, payload: body });
  expect(put.statusCode).toBe(200);
  const done = await c.req("POST", `/files/${start.body.file.id}/complete`, {});
  expect(done.status).toBe(200);
  return done.body.id as string;
}

async function download(c: Client, fileId: string, host = "localhost") {
  const res = await env.app.inject({ method: "GET", url: `/api/v1/files/${fileId}`, headers: { host, cookie: c.cookie } });
  expect(res.statusCode).toBe(302);
  const file = await env.app.inject({ method: "GET", url: res.headers.location as string, headers: { host } });
  expect(file.statusCode).toBe(200);
  return file.rawPayload;
}

async function runJobs() {
  while ((await runDueJobs(10)) > 0);
}

beforeAll(async () => {
  env = await setup();
  admin = new Client(env.app);
  expect((await admin.login("admin@default.test")).status).toBe(200);
  expect((await admin.req("POST", "/users", { email: "learner@default.test", firstName: "Lea", lastName: "Rner", password: PASSWORD })).status).toBe(201);
  student = new Client(env.app);
  await student.login("learner@default.test");

  const course = await admin.req("POST", "/courses", { fullname: "Chemistry 101", shortname: "CHEM101", summary: "<p>Atoms</p>", selfEnrol: "open" });
  courseId = course.body.id;
  expect((await student.req("POST", `/courses/${courseId}/enrol`, {})).status).toBe(200);
  const general = (await admin.req("GET", `/courses/${courseId}`)).body.sections[0].id;
  const week2 = await admin.req("POST", `/courses/${courseId}/sections`, { title: "Week 2", summary: "<p>Reactions</p>" });
  expect(week2.status).toBe(201);
  expect((await admin.req("POST", `/courses/${courseId}/groups`, { name: "Lab A" })).status).toBe(201);

  const make = async (key: string, body: Record<string, unknown>) => {
    const res = await admin.req("POST", `/courses/${courseId}/activities`, body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    act[key] = res.body.id;
  };
  await make("page", { type: "page", sectionId: general, name: "Welcome", completionRule: "view", settings: { content: "<p>Hello <b>chemists</b></p>" } });
  await make("url", { type: "url", sectionId: general, name: "Periodic table", settings: { externalUrl: "https://example.com/table", openInNewTab: false } });
  const fileId = await upload(admin, "notes.txt", "text/plain", Buffer.from("Lab safety notes"));
  await make("file", { type: "file", sectionId: general, name: "Safety notes", settings: { fileId, display: "download" } });
  await make("assignment", {
    type: "assignment",
    sectionId: week2.body.id,
    name: "Lab report",
    description: "<p>Write it up</p>",
    settings: { instructions: "<p>Max 2 pages</p>", allowText: false, maxFiles: 2, dueAt: "2030-01-15T10:00:00.000Z", gradeMax: 40, gradePass: 20, acceptedTypes: [".pdf"] },
  });
  await make("forum", { type: "forum", sectionId: week2.body.id, name: "Questions", settings: { type: "qanda", intro: "<p>Ask</p>", completionPosts: 2 } });
  await make("quiz", { type: "quiz", sectionId: week2.body.id, name: "Atoms quiz", visible: false, settings: { attemptsAllowed: 3, gradeMax: 20, timeLimitSeconds: 900, shuffleAnswers: false } });

  const cat = await admin.req("POST", "/question-bank/categories", { courseId, name: "Atoms" });
  expect(cat.status).toBe(201);
  q.cat = cat.body.id;
  const mc = await admin.req("POST", "/question-bank/questions", {
    categoryId: cat.body.id,
    type: "multichoice",
    name: "Hydrogen",
    text: "<p>Atomic number of H?</p>",
    defaultMark: 2,
    data: { single: true, options: [{ id: "a", text: "1", fraction: 1, feedback: "Right" }, { id: "b", text: "2", fraction: 0, feedback: "" }] },
  });
  expect(mc.status).toBe(201);
  q.mc = mc.body.id;
  // A second version, so pinned/latest versions are exercised.
  expect((await admin.req("PUT", `/question-bank/questions/${q.mc}`, { ...mc.body.current, type: "multichoice", name: "Hydrogen v2" })).status).toBe(200);
  const tf = await admin.req("POST", "/question-bank/questions", { categoryId: cat.body.id, type: "truefalse", name: "Noble", text: "Helium is a noble gas", data: { correct: true } });
  q.tf = tf.body.id;
  expect((await admin.req("POST", `/quizzes/${act.quiz}/slots`, { questionIds: [q.mc, q.tf] })).status).toBe(200);
});

afterAll(async () => {
  await env.app.close();
  await closeDb();
});

describe("backup", () => {
  it("requires course:backup", async () => {
    expect((await student.req("POST", `/backups/courses/${courseId}`, {})).status).toBe(403);
    expect((await student.req("GET", `/backups?courseId=${courseId}`)).status).toBe(403);
  });

  it("creates a backup archive in a durable job", async () => {
    const created = await admin.req("POST", `/backups/courses/${courseId}`, { includeFiles: true, includeUserData: true });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe("queued");
    await runJobs();
    const row = await admin.req("GET", `/backups/${created.body.id}`);
    expect(row.body.status, row.body.error).toBe("done");
    expect(row.body.file.filename).toMatch(/^backup-CHEM101-.*\.zip$/);
    backupFileId = row.body.fileId;
    expect((await student.req("GET", `/backups/${created.body.id}`)).status).toBe(404);
    expect((await admin.req("GET", `/backups?courseId=${courseId}`)).body).toHaveLength(1);

    const zip = await download(admin, backupFileId);
    const entries = listZip(zip);
    const names = entries.map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(["manifest.json", "course.json"]));
    expect(names.some((n) => n.startsWith("files/") && n.endsWith("/notes.txt"))).toBe(true);
    const manifest = JSON.parse(readZipEntry(zip, entries.find((e) => e.name === "manifest.json")!).toString());
    expect(manifest).toMatchObject({ format: "lms-backup", version: 1, course: { shortname: "CHEM101" }, options: { includeUserData: true } });
    const course = JSON.parse(readZipEntry(zip, entries.find((e) => e.name === "course.json")!).toString());
    expect(course.userData.users.map((u: { email: string }) => u.email)).toContain("learner@default.test");
    expect(course.questionBank.questions.find((x: { id: string }) => x.id === q.mc).versions).toHaveLength(2);
    // Students can't download the archive.
    expect((await student.req("GET", `/files/${backupFileId}`)).status).toBe(403);
  });
});

describe("restore", () => {
  let restoredId: string;

  it("requires course:restore", async () => {
    const fid = await upload(student, "x.zip", "application/zip", Buffer.from("PK"));
    expect((await student.req("POST", "/backups/restore", { fileId: fid })).status).toBe(403);
    // Someone else's file can't be used.
    expect((await admin.req("POST", "/backups/restore", { fileId: fid })).status).toBe(400);
  });

  it("restores into a new course with structure, settings and questions, remapping ids", async () => {
    const res = await admin.req("POST", "/backups/restore", { fileId: backupFileId, fullname: "Chemistry 101 (copy)" });
    expect(res.status).toBe(201);
    await runJobs();
    const row = await admin.req("GET", `/backups/${res.body.id}`);
    expect(row.body.status, row.body.error).toBe("done");
    restoredId = row.body.courseId;
    expect(restoredId).not.toBe(courseId);
    expect(row.body.report.counts).toMatchObject({ activities: 6, questions: 2, quizSlots: 2, sections: 2, groups: 1 });
    expect(row.body.report.unsupported.join(" ")).toMatch(/User data/);

    const overview = await admin.req("GET", `/courses/${restoredId}`);
    expect(overview.body.course).toMatchObject({ fullname: "Chemistry 101 (copy)", shortname: "CHEM101_1", summary: "<p>Atoms</p>" });
    expect(overview.body.sections.map((s: { title: string }) => s.title)).toEqual(["General", "Week 2"]);
    const all = overview.body.sections.flatMap((s: { activities: { id: string; name: string; type: string; visible: boolean }[] }) => s.activities);
    expect(all.map((a: { name: string }) => a.name)).toEqual(["Welcome", "Periodic table", "Safety notes", "Lab report", "Questions", "Atoms quiz"]);
    const byName = (n: string) => all.find((a: { name: string }) => a.name === n)!;
    for (const a of all) expect(Object.values(act)).not.toContain(a.id);
    expect(byName("Atoms quiz").visible).toBe(false);
    expect(byName("Welcome").completionRule).toBe("view");

    const page = await admin.req("GET", `/activities/${byName("Welcome").id}`);
    expect(page.body.settings.content).toBe("<p>Hello <b>chemists</b></p>");
    const url = await admin.req("GET", `/activities/${byName("Periodic table").id}`);
    expect(url.body.settings).toMatchObject({ externalUrl: "https://example.com/table", openInNewTab: false });
    const file = await admin.req("GET", `/activities/${byName("Safety notes").id}`);
    expect(file.body.settings).toMatchObject({ filename: "notes.txt", display: "download" });
    expect(file.body.settings.fileId).not.toBeNull();
    expect((await download(admin, file.body.settings.fileId)).toString()).toBe("Lab safety notes");
    const assign = await admin.req("GET", `/activities/${byName("Lab report").id}`);
    expect(assign.body.description).toBe("<p>Write it up</p>");
    expect(assign.body.settings).toMatchObject({ instructions: "<p>Max 2 pages</p>", allowText: false, maxFiles: 2, gradeMax: 40, gradePass: 20, acceptedTypes: [".pdf"] });
    expect(new Date(assign.body.settings.dueAt).toISOString()).toBe("2030-01-15T10:00:00.000Z");
    const forum = await admin.req("GET", `/activities/${byName("Questions").id}`);
    expect(forum.body.settings).toMatchObject({ type: "qanda", completionPosts: 2 });
    const quiz = await admin.req("GET", `/activities/${byName("Atoms quiz").id}`);
    expect(quiz.body.settings).toMatchObject({ attemptsAllowed: 3, gradeMax: 20, timeLimitSeconds: 900, shuffleAnswers: false });

    const slots = await admin.req("GET", `/quizzes/${byName("Atoms quiz").id}/slots`);
    expect(slots.body.slots.map((s: { name: string; maxMark: number; latestVersion: number }) => [s.name, s.maxMark, s.latestVersion])).toEqual([
      ["Hydrogen v2", 2, 2],
      ["Noble", 1, 1],
    ]);
    for (const s of slots.body.slots) expect([q.mc, q.tf]).not.toContain(s.questionId);
    // Questions live in the new course's bank.
    const cats = await admin.req("GET", `/question-bank/categories?courseId=${restoredId}`);
    const restoredCat = cats.body.find((c: { courseId: string | null }) => c.courseId === restoredId);
    expect(restoredCat).toMatchObject({ name: "Atoms", questionCount: 2 });
    expect(restoredCat.id).not.toBe(q.cat);

    // Gradebook: activity grade items were recreated for the new activities.
    const db = await systemDb();
    const items = await db.select().from(gradeItems).where(eq(gradeItems.courseId, restoredId));
    expect(items.find((i) => i.activityId === byName("Lab report").id)).toMatchObject({ type: "activity", gradeMax: 40, gradePass: 20 });
    expect(items.filter((i) => i.type === "course")).toHaveLength(1);
    const groups = await admin.req("GET", `/courses/${restoredId}/groups`);
    expect(groups.body.map((g: { name: string }) => g.name)).toEqual(["Lab A"]);
    // The original is untouched.
    const original = await admin.req("GET", `/courses/${courseId}`);
    expect(original.body.sections.flatMap((s: { activities: unknown[] }) => s.activities)).toHaveLength(6);
  });

  it("restores across organizations and enrols users that exist by email", async () => {
    const zip = await download(admin, backupFileId);
    const acme = new Client(env.app, "acme.localhost");
    expect((await acme.login("admin@acme.test")).status).toBe(200);
    expect((await acme.req("POST", "/users", { email: "learner@default.test", firstName: "Lea", lastName: "Acme", password: PASSWORD })).status).toBe(201);
    const fid = await upload(acme, "chem.zip", "application/zip", zip, "acme.localhost");
    const res = await acme.req("POST", "/backups/restore", { fileId: fid, restoreEnrolments: true });
    expect(res.status).toBe(201);
    await runJobs();
    const row = await acme.req("GET", `/backups/${res.body.id}`);
    expect(row.body.status, row.body.error).toBe("done");
    expect(row.body.report.counts.enrolments).toBe(1);
    expect(row.body.report.warnings.join(" ")).toMatch(/skipped: no user with that email/);
    const participants = await acme.req("GET", `/courses/${row.body.courseId}/participants`);
    expect(participants.body.items.map((p: { email: string }) => p.email)).toContain("learner@default.test");
    // The other organization can't see this restore.
    expect((await admin.req("GET", `/backups/${res.body.id}`)).status).toBe(404);
  });

  it("rejects archives that are not backups", async () => {
    const bad = await upload(admin, "junk.zip", "application/zip", Buffer.from("not a zip at all"));
    const res = await admin.req("POST", "/backups/restore", { fileId: bad });
    await runJobs();
    const row = await admin.req("GET", `/backups/${res.body.id}`);
    expect(row.body.status).toBe("failed");
    expect(row.body.error).toMatch(/Unsupported archive/);
  });
});

// ─── Moodle .mbz import ──────────────────────────────────────────────────────

function tarEntry(name: string, data: string) {
  const body = Buffer.from(data);
  const h = Buffer.alloc(512);
  h.write(name, 0, "utf8");
  h.write("0000644\0", 100);
  h.write(body.length.toString(8).padStart(11, "0") + "\0", 124);
  h.write("00000000000\0", 136);
  h.write("        ", 148);
  h.write("0", 156);
  h.write("ustar\0", 257);
  h.write("00", 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return Buffer.concat([h, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}

function mbz() {
  const activity = (id: number, mod: string, section: number, title: string) =>
    `<activity><moduleid>${id}</moduleid><sectionid>${section}</sectionid><modulename>${mod}</modulename><title>${title}</title><directory>activities/${mod}_${id}</directory></activity>`;
  const module = (id: number, mod: string, visible = 1) => `<?xml version="1.0" encoding="UTF-8"?><module id="${id}"><modulename>${mod}</modulename><visible>${visible}</visible><completion>1</completion></module>`;
  const files: [string, string][] = [
    [
      "moodle_backup.xml",
      `<?xml version="1.0" encoding="UTF-8"?><moodle_backup><information><name>backup.mbz</name><moodle_release>4.1</moodle_release><original_course_fullname>Moodle Physics</original_course_fullname><original_course_shortname>PHY</original_course_shortname><contents><activities>${[
        activity(11, "page", 1, "Intro"),
        activity(12, "url", 1, "Docs"),
        activity(13, "assign", 2, "Essay"),
        activity(14, "forum", 2, "Talk"),
        activity(15, "quiz", 2, "Test"),
        activity(16, "label", 1, "Note"),
        activity(17, "glossary", 2, "Terms"),
      ].join("")}</activities><sections><section><sectionid>1</sectionid><title>0</title><directory>sections/section_1</directory></section><section><sectionid>2</sectionid><title>1</title><directory>sections/section_2</directory></section></sections><course><courseid>5</courseid><directory>course</directory></course></contents></information></moodle_backup>`,
    ],
    ["course/course.xml", `<course id="5"><shortname>PHY</shortname><fullname>Moodle Physics</fullname><summary>&lt;p&gt;Forces&lt;/p&gt;</summary><format>weeks</format><startdate>0</startdate><visible>1</visible></course>`],
    ["sections/section_1/section.xml", `<section id="1"><number>0</number><name>$@NULL@$</name><summary></summary><sequence>11,16,12</sequence><visible>1</visible></section>`],
    ["sections/section_2/section.xml", `<section id="2"><number>1</number><name>Mechanics</name><summary>&lt;p&gt;Newton&lt;/p&gt;</summary><sequence>13,14,15,17</sequence><visible>1</visible></section>`],
    ["activities/page_11/module.xml", module(11, "page")],
    ["activities/page_11/page.xml", `<activity id="1" moduleid="11" modulename="page"><page id="1"><name>Intro</name><intro></intro><content><![CDATA[<p>Welcome to physics</p>]]></content></page></activity>`],
    ["activities/url_12/module.xml", module(12, "url")],
    ["activities/url_12/url.xml", `<activity id="2" moduleid="12" modulename="url"><url id="2"><name>Docs</name><intro></intro><externalurl>https://example.org/docs</externalurl></url></activity>`],
    ["activities/assign_13/module.xml", module(13, "assign")],
    [
      "activities/assign_13/assign.xml",
      `<activity id="3" moduleid="13" modulename="assign"><assign id="3"><name>Essay</name><intro>&lt;p&gt;Explain inertia&lt;/p&gt;</intro><duedate>1893456000</duedate><cutoffdate>0</cutoffdate><grade>50</grade><plugin_configs><plugin_config><plugin>onlinetext</plugin><subtype>assignsubmission</subtype><name>enabled</name><value>1</value></plugin_config><plugin_config><plugin>file</plugin><subtype>assignsubmission</subtype><name>maxfilesubmissions</name><value>3</value></plugin_config></plugin_configs></assign></activity>`,
    ],
    ["activities/forum_14/module.xml", module(14, "forum", 0)],
    ["activities/forum_14/forum.xml", `<activity id="4" moduleid="14" modulename="forum"><forum id="4"><type>qanda</type><name>Talk</name><intro>Discuss</intro></forum></activity>`],
    ["activities/quiz_15/module.xml", module(15, "quiz")],
    ["activities/quiz_15/quiz.xml", `<activity id="5" moduleid="15" modulename="quiz"><quiz id="5"><name>Test</name><intro></intro><timelimit>600</timelimit><attempts_number>2</attempts_number><grademethod>3</grademethod><grade>10</grade></quiz></activity>`],
    ["activities/label_16/module.xml", module(16, "label")],
    ["activities/label_16/label.xml", `<activity id="6" moduleid="16" modulename="label"><label id="6"><name>Note</name><intro>&lt;p&gt;Bring a calculator&lt;/p&gt;</intro></label></activity>`],
  ];
  return gzipSync(Buffer.concat([...files.map(([n, d]) => tarEntry(n, d)), Buffer.alloc(1024)]));
}

describe("Moodle .mbz import", () => {
  it("creates a course with sections and supported activities, reporting the rest", async () => {
    const fid = await upload(admin, "physics.mbz", "application/zip", mbz());
    const res = await admin.req("POST", "/backups/restore", { fileId: fid });
    expect(res.status).toBe(201);
    await runJobs();
    const row = await admin.req("GET", `/backups/${res.body.id}`);
    expect(row.body.status, row.body.error).toBe("done");
    expect(row.body.report.source.format).toBe("moodle");
    expect(row.body.report.unsupported.join(" ")).toMatch(/glossary/);
    expect(row.body.report.warnings.join(" ")).toMatch(/Quiz "Test" was imported without questions/);

    const overview = await admin.req("GET", `/courses/${row.body.courseId}`);
    expect(overview.body.course).toMatchObject({ fullname: "Moodle Physics", shortname: "PHY", format: "weeks" });
    expect(overview.body.sections.map((s: { title: string }) => s.title)).toEqual(["General", "Mechanics"]);
    expect(overview.body.sections[0].activities.map((a: { name: string; type: string }) => `${a.type}:${a.name}`)).toEqual(["page:Intro", "page:Note", "url:Docs"]);
    const s2 = overview.body.sections[1].activities;
    expect(s2.map((a: { type: string }) => a.type)).toEqual(["assignment", "forum", "quiz"]);
    expect(s2[1].visible).toBe(false);
    const assign = await admin.req("GET", `/activities/${s2[0].id}`);
    expect(assign.body.settings).toMatchObject({ gradeMax: 50, allowText: true, maxFiles: 3 });
    expect(new Date(assign.body.settings.dueAt).getTime()).toBe(1893456000 * 1000);
    const quiz = await admin.req("GET", `/activities/${s2[2].id}`);
    expect(quiz.body.settings).toMatchObject({ timeLimitSeconds: 600, attemptsAllowed: 2, gradeMethod: "first" });
  });
});
