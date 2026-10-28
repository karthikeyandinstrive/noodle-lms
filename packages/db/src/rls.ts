import { sql } from "drizzle-orm";
import { APP_ROLE, type DB } from "./client";

/** Tables that are intentionally not tenant-scoped. */
const GLOBAL_TABLES = new Set(["webhook_events"]);

const TENANT_EXPR = `nullif(current_setting('app.org_id', true), '')::uuid`;

async function run(db: DB, statements: string[]) {
  // Prepared statements accept one command each.
  for (const s of statements) await db.execute(sql.raw(s));
}

function rows<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

/**
 * Idempotently (re)creates the application role and a tenant-isolation policy
 * on every table that has an organization_id column. Run after migrations.
 */
export async function applyRowLevelSecurity(db: DB) {
  await run(db, [
    `do $$ begin
       if not exists (select 1 from pg_roles where rolname = '${APP_ROLE}') then
         create role ${APP_ROLE} nologin;
       end if;
     end $$`,
    `grant usage on schema public to ${APP_ROLE}`,
    `grant select, insert, update, delete on all tables in schema public to ${APP_ROLE}`,
    `grant usage, select on all sequences in schema public to ${APP_ROLE}`,
    // Allow the connecting (owner) user to switch into the app role.
    `do $$ begin execute format('grant ${APP_ROLE} to %I', current_user); exception when others then null; end $$`,
  ]);

  const tables = rows<{ table_name: string }>(
    await db.execute(sql`
      select table_name from information_schema.columns
      where table_schema = 'public' and column_name = 'organization_id'
    `),
  );

  for (const { table_name } of tables) {
    if (GLOBAL_TABLES.has(table_name)) continue;
    await run(db, [
      `alter table "${table_name}" enable row level security`,
      `drop policy if exists tenant_isolation on "${table_name}"`,
      `create policy tenant_isolation on "${table_name}" to ${APP_ROLE}
         using (organization_id = ${TENANT_EXPR})
         with check (organization_id = ${TENANT_EXPR})`,
    ]);
  }

  await run(db, [
    `alter table organizations enable row level security`,
    `drop policy if exists tenant_isolation on organizations`,
    `create policy tenant_isolation on organizations to ${APP_ROLE}
       using (id = ${TENANT_EXPR}) with check (id = ${TENANT_EXPR})`,
  ]);
}
