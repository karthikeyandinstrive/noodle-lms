import path from "node:path";
import { getClient } from "./client";
import { applyRowLevelSecurity } from "./rls";

const migrationsFolder = path.resolve(import.meta.dirname, "../migrations");

/** Applies pending migrations, then (re)creates RLS policies. */
export async function runMigrations() {
  const { db, driver } = await getClient();
  if (driver === "pg") {
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    await migrate(db as never, { migrationsFolder });
  } else {
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    await migrate(db as never, { migrationsFolder });
  }
  await applyRowLevelSecurity(db);
  return driver;
}
