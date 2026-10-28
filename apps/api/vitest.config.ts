import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests use an isolated in-memory Postgres per test file.
    env: { PGLITE_DIR: "memory://", NODE_ENV: "test", LOG_LEVEL: "silent", BASE_DOMAIN: "localhost", DEFAULT_ORG_SLUG: "default" },
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: "forks",
  },
});
