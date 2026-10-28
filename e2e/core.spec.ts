import { expect, login, openSeededCourse, PASSWORD, test, users } from "./fixtures";

test.describe("authentication", () => {
  test("rejects a wrong password", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(users.admin);
    await page.getByLabel("Password", { exact: true }).fill("not-the-password1");
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page.getByText(/invalid email or password/i).first()).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test("redirects signed-out users to login and back @mobile", async ({ page }) => {
    await page.goto("/catalog");
    await expect(page).toHaveURL(/\/login\?next=%2Fcatalog/);
    await page.getByLabel("Email").fill(users.student);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/catalog/);
  });
});

test.describe("permissions", () => {
  test("students don't see administration and can't use admin APIs", async ({ page }) => {
    await login(page, users.student);
    await expect(page.getByRole("link", { name: "Users" })).toHaveCount(0);
    const res = await page.request.get("/api/v1/users");
    expect(res.status()).toBe(403);
  });

  test("admins see the administration menu", async ({ page }) => {
    await login(page, users.admin);
    await expect(page.getByRole("link", { name: "Users" }).first()).toBeVisible();
    await page.goto("/admin/users");
    // The list renders a desktop and a mobile variant; assert on the visible one.
    await expect(page.getByText(users.student).filter({ visible: true }).first()).toBeVisible();
  });
});

test.describe("teaching and learning flow", () => {
  const assignmentName = `E2E essay ${Date.now()}`;

  test("teacher adds an assignment", async ({ page }) => {
    await login(page, users.teacher);
    await openSeededCourse(page);
    const courseUrl = page.url();
    await page.goto(`${courseUrl}/activities/new?type=assignment`);
    await page.getByLabel("Name", { exact: true }).fill(assignmentName);
    await page.getByRole("button", { name: /add activity/i }).click();
    await expect(page.getByRole("heading", { name: assignmentName })).toBeVisible();
  });

  test("student submits and teacher grades", async ({ browser }) => {
    const student = await (await browser.newContext()).newPage();
    await login(student, users.student);
    await openSeededCourse(student);
    await student.getByRole("link", { name: assignmentName }).click();
    await expect(student.getByRole("heading", { name: assignmentName })).toBeVisible();

    // Online text submission through the API used by the page (editor widgets vary by type).
    const activityId = student.url().split("/activities/")[1]!.split(/[/?]/)[0]!;
    const origin = new URL(student.url()).origin;
    const headers = { origin, "content-type": "application/json" };
    expect((await student.request.put(`/api/v1/assignments/${activityId}/draft`, { data: { text: "<p>My answer</p>", fileIds: [] }, headers })).ok()).toBe(true);
    expect((await student.request.post(`/api/v1/assignments/${activityId}/submit`, { data: {}, headers })).ok()).toBe(true);

    const teacher = await (await browser.newContext()).newPage();
    await login(teacher, users.teacher);
    await teacher.goto(`/activities/${activityId}/assignment/submissions`);
    await expect(teacher.getByText("Sara Student").first()).toBeVisible();

    const me = await (await student.request.get("/api/v1/auth/me")).json();
    const graded = await teacher.request.post(`/api/v1/assignments/${activityId}/submissions/${me.user.id}/grade`, {
      data: { grade: 90, feedback: "Great" },
      headers: { origin, "content-type": "application/json" },
    });
    expect(graded.ok()).toBe(true);

    await student.goto("/notifications");
    await expect(student.getByText(new RegExp(`${assignmentName}.*graded`, "i")).first()).toBeVisible();
  });
});

test("security headers are set on pages", async ({ page }) => {
  const res = await page.goto("/login");
  expect(res?.headers()["x-content-type-options"]).toBe("nosniff");
  expect(res?.headers()["x-frame-options"]).toBe("SAMEORIGIN");
});
