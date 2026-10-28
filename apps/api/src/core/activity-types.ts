import type { z } from "zod";
import type { activities, DB } from "@lms/db";
import { badRequest } from "./errors";

export type ActivityRow = typeof activities.$inferSelect;
export type ActivityType = ActivityRow["type"];

export type ActivityTypeContext = { organizationId: string; userId: string; activity: ActivityRow };

/**
 * Contract each activity module implements so the generic activities API
 * (modules/activities) can create/update/load it. Type-specific interaction
 * (submitting, attempting, posting…) lives in the module's own routes.
 */
export type ActivityTypeHandler<S extends z.ZodRawShape = z.ZodRawShape> = {
  type: ActivityType;
  label: string;
  /** Settings accepted on create; `.partial()` is used for update. */
  settings: z.ZodObject<S>;
  create(tx: DB, ctx: ActivityTypeContext, settings: z.infer<z.ZodObject<S>>): Promise<void>;
  update(tx: DB, ctx: ActivityTypeContext, settings: Partial<z.infer<z.ZodObject<S>>>): Promise<void>;
  /** Settings returned with the activity (must not include secrets or answers). */
  load(tx: DB, activity: ActivityRow): Promise<Record<string, unknown> | null>;
  /** Present for gradable types: drives creation of the activity's grade item. */
  grading?: (tx: DB, activity: ActivityRow) => Promise<{ gradeMax: number; gradePass: number | null }>;
  /**
   * Called inside the deleting transaction, before the activity row goes (alone or with its course).
   * Database rows cascade; use this for data outside the database, e.g. queue storage cleanup.
   */
  remove?: (tx: DB, activity: ActivityRow) => Promise<void>;
};

const registry = new Map<ActivityType, ActivityTypeHandler>();

export function registerActivityType<S extends z.ZodRawShape>(handler: ActivityTypeHandler<S>) {
  registry.set(handler.type, handler as unknown as ActivityTypeHandler);
}

export function activityType(type: ActivityType) {
  const handler = registry.get(type);
  if (!handler) throw badRequest(`Activity type "${type}" is not available`);
  return handler;
}

/** Runs each type's `remove` hook for activities about to be deleted. */
export async function beforeActivitiesDeleted(tx: DB, rows: ActivityRow[]) {
  for (const row of rows) await registry.get(row.type)?.remove?.(tx, row);
}

export function registeredActivityTypes() {
  return [...registry.values()];
}
