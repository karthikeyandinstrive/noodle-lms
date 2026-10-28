import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "@lms/db";
import { Client, ORIGIN, PASSWORD, setup, type TestEnv } from "../../../test/helpers";

/** GIFT import/export over HTTP (in-memory PGlite). */
let env: TestEnv;
let admin: Client;
let student: Client;
let courseId: string;
let catId: string;

beforeAll(async () => {
  env = await setup();
  admin = new Client(env.app);
  expect((await admin.login("admin@default.test")).status).toBe(200);
  expect((await admin.req("POST", "/users", { email: "s1@default.test", firstName: "Stu", lastName: "One", password: PASSWORD })).status).toBe(201);
  student = new Client(env.app);
  await student.login("s1@default.test");
  courseId = (await admin.req("POST", "/courses", { fullname: "Gift", shortname: "GIFT", selfEnrol: "open" })).body.id;
  await student.req("POST", `/courses/${courseId}/enrol`, {});
  catId = (await admin.req("POST", "/question-bank/categories", { courseId, name: "Imported" })).body.id;
});

afterAll(async () => {
  await env.app.close();
  await closeDb();
});

const GIFT = `// sample
$CATEGORY: $course$/top/Unit 1

::TF::[html]<p>The sky is blue.</p>{T}

::MC::Capital of France? {=Paris#Yes ~Lyon ~Marseille ####Paris since 987}

$CATEGORY: $course$/top/Unit 2

::SA::Two plus {=two =2} equals four.

::NUM::Pi to two decimals? {#3.14:0.005}

::MATCH::Match. {=cat -> meow =dog -> woof = -> moo}

::ESSAY::Discuss. {}
`;

async function exportGift(client: Client, id: string) {
  return env.app.inject({ method: "GET", url: `/api/v1/question-bank/categories/${id}/export.gift?courseId=${courseId}`, headers: { host: "localhost", origin: ORIGIN, cookie: client.cookie } });
}

describe("GIFT import/export", () => {
  it("imports every supported type and creates sub-categories from $CATEGORY", async () => {
    const r = await admin.req("POST", `/question-bank/categories/${catId}/import-gift`, { text: GIFT, createCategories: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ imported: 6, categoriesCreated: 2, warnings: [] });
    const cats = (await admin.req("GET", `/question-bank/categories?courseId=${courseId}`)).body as {
      id: string;
      name: string;
      parentId: string | null;
      questionCount: number;
    }[];
    const unit1 = cats.find((c) => c.name === "Unit 1")!;
    const unit2 = cats.find((c) => c.name === "Unit 2")!;
    expect(unit1).toMatchObject({ parentId: catId, questionCount: 2 });
    expect(unit2).toMatchObject({ parentId: catId, questionCount: 4 });
  });

  it("ignores $CATEGORY lines by default", async () => {
    const r = await admin.req("POST", `/question-bank/categories/${catId}/import-gift`, { text: GIFT });
    expect(r.body).toMatchObject({ imported: 6, categoriesCreated: 0 });
    const list = await admin.req("GET", `/question-bank/categories/${catId}/questions?courseId=${courseId}`);
    expect(list.body.total).toBe(6);
  });

  it("exports as a GIFT attachment that re-imports identically", async () => {
    const res = await exportGift(admin, catId);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(String(res.headers["content-disposition"])).toMatch(/^attachment; filename="Imported\.gift\.txt"/);
    expect(res.body).toContain("::MC::[html]Capital of France?{");

    const copy = (await admin.req("POST", "/question-bank/categories", { courseId, name: "Copy" })).body.id;
    const r = await admin.req("POST", `/question-bank/categories/${copy}/import-gift`, { text: res.body });
    expect(r.body.imported).toBe(6);
    const again = await exportGift(admin, copy);
    const strip = (s: string) => s.replace(/^\/\/.*\n/gm, "");
    expect(strip(again.body)).toBe(strip(res.body));
  });

  it("is all-or-nothing and reports errors per question", async () => {
    const before = (await admin.req("GET", `/question-bank/categories/${catId}/questions?courseId=${courseId}`)).body.total;
    const r = await admin.req("POST", `/question-bank/categories/${catId}/import-gift`, {
      text: "::Ok::Fine {T}\n\n::Cloze::A {=a} B {=b}\n\n::NoRight::Pick {=%50%a ~b}\n\n::Desc::Just text",
    });
    expect(r.status).toBe(400);
    expect(r.body.error.details.map((d: { title: string }) => d.title)).toEqual(["Cloze", "NoRight", "Desc"]);
    expect(r.body.error.details[1]).toMatchObject({ index: 1, line: 5, message: expect.stringMatching(/100%/) });
    expect((await admin.req("GET", `/question-bank/categories/${catId}/questions?courseId=${courseId}`)).body.total).toBe(before);
  });

  it("keeps the bank private", async () => {
    expect((await exportGift(student, catId)).statusCode).toBe(404);
    expect((await student.req("POST", `/question-bank/categories/${catId}/import-gift`, { text: "Q {T}" })).status).toBe(404);
  });
});
