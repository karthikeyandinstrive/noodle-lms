import { closeDb } from "./client";
import { runMigrations } from "./migrations";

const driver = await runMigrations();
console.log(`✓ migrations applied (${driver}), RLS policies refreshed`);
await closeDb();
process.exit(0);
