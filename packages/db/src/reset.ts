import { sql } from "drizzle-orm";
import { closeDb, getClient } from "./client";

if (process.env.NODE_ENV === "production") throw new Error("Refusing to reset a production database");

const { db } = await getClient();
for (const statement of ["drop schema if exists public cascade", "drop schema if exists drizzle cascade", "create schema public"]) {
  await db.execute(sql.raw(statement));
}
console.log("✓ database reset");
await closeDb();
process.exit(0);
