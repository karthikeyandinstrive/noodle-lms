import { mkdirSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";

export type Schema = typeof schema;
/** Works for the root database and for transactions. */
export type DB = PgDatabase<PgQueryResultHKT, Schema>;

/** Postgres role used for tenant-scoped queries. RLS policies apply to it. */
export const APP_ROLE = "lms_app";

type Client = { db: DB; close: () => Promise<void>; driver: "pg" | "pglite" };

let client: Client | undefined;

/** Repo root, so the embedded dev database lives in one place whichever workspace starts it. */
function repoRoot() {
  return process.env.LMS_ROOT ?? path.resolve(import.meta.dirname, "../../..");
}

async function connect(): Promise<Client> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { Pool } = await import("pg");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const pool = new Pool({ connectionString: url, max: Number(process.env.DATABASE_POOL_MAX ?? 10) });
    return { db: drizzle(pool, { schema, casing: "snake_case" }) as unknown as DB, close: () => pool.end(), driver: "pg" };
  }

  // Development fallback: embedded Postgres (PGlite) persisted to .data/pglite.
  if (process.env.NODE_ENV === "production") {
    throw new Error("DATABASE_URL is required in production");
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  // PGLITE_DIR=memory:// gives an isolated throwaway database (integration tests).
  const dir = process.env.PGLITE_DIR ?? path.join(repoRoot(), ".data", "pglite");
  if (!dir.startsWith("memory://")) mkdirSync(dir, { recursive: true });
  const pg = new PGlite(dir);
  await pg.waitReady;
  return { db: drizzle(pg, { schema, casing: "snake_case" }) as unknown as DB, close: () => pg.close(), driver: "pglite" };
}

export async function getClient(): Promise<Client> {
  client ??= await connect();
  return client;
}

/** Unscoped database handle. Bypasses RLS — use only for cross-tenant work (auth lookup, webhooks, platform admin). */
export async function systemDb(): Promise<DB> {
  return (await getClient()).db;
}

/**
 * Runs `fn` in a transaction scoped to one organization. Row Level Security
 * policies restrict every query to rows with that organization_id.
 */
export async function withTenant<T>(organizationId: string, fn: (tx: DB) => Promise<T>): Promise<T> {
  const db = await systemDb();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.org_id', ${organizationId}, true)`);
    await tx.execute(sql.raw(`set local role ${APP_ROLE}`));
    return fn(tx as unknown as DB);
  });
}

export async function closeDb() {
  await client?.close();
  client = undefined;
}
