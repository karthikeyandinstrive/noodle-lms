import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests against the real app (web + API) on a throwaway embedded
 * database (.data/pglite-e2e), on ports that don't clash with `npm run dev`.
 */
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3200);
const API_PORT = Number(process.env.E2E_API_PORT ?? 4200);
const baseURL = `http://localhost:${WEB_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] }, grep: /@mobile/ },
  ],
  webServer: {
    command: "sh e2e/start-servers.sh",
    url: `${baseURL}/login`,
    timeout: 240_000,
    reuseExistingServer: !process.env.CI,
    env: { E2E_WEB_PORT: String(WEB_PORT), E2E_API_PORT: String(API_PORT) },
  },
});
