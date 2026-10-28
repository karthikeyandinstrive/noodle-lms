import { expect, test as base, type Page } from "@playwright/test";

export const PASSWORD = process.env.SEED_PASSWORD ?? "E2ePassword123";

export const users = {
  admin: "admin@example.com",
  teacher: "teacher@example.com",
  student: "student1@example.com",
} as const;

export async function login(page: Page, email: string, password = PASSWORD) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

/** Opens the seeded WEB101 course from the catalog. */
export async function openSeededCourse(page: Page) {
  await page.goto("/catalog");
  await page.getByText("Introduction to Web Development").first().click();
  await expect(page.getByRole("heading", { name: "Introduction to Web Development" })).toBeVisible();
}

export const test = base;
export { expect };
