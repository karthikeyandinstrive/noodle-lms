import { and, eq, max } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { Capability } from "@lms/rbac";
import { activities, courseSections, courses, type DB } from "@lms/db";
import type { ActivityRow, ActivityType } from "../../core/activity-types";
import { AppError, must, notFound } from "../../core/errors";
import { hasCapability, requireCapability } from "../../core/rbac";

/**
 * Loads an activity the current user may access — the entry point every
 * activity module uses before acting on its own records.
 *
 *  - course:view in the activity context (inherited from the course)
 *  - hidden activity/section → only with course:view_hidden
 *  - outside availability window → only for users with activity:update
 *  - optional `type` guard and extra `capability`
 *
 * Inaccessible activities return 404 so their existence is not revealed.
 */
export async function loadActivity(
  tx: DB,
  req: FastifyRequest,
  activityId: string,
  opts: { type?: ActivityType; capability?: Capability } = {},
) {
  const [row] = await tx
    .select({ activity: activities, course: courses, section: courseSections })
    .from(activities)
    .innerJoin(courses, eq(courses.id, activities.courseId))
    .innerJoin(courseSections, eq(courseSections.id, activities.sectionId))
    .where(eq(activities.id, activityId))
    .limit(1);
  if (!row || (opts.type && row.activity.type !== opts.type)) throw notFound("Activity");
  const { activity, course, section } = row;

  if (!(await hasCapability(tx, req, "course:view", activity.contextId))) throw notFound("Activity");
  const canSeeHidden = await hasCapability(tx, req, "course:view_hidden", activity.contextId);
  if ((!activity.visible || !section.visible || !course.visible) && !canSeeHidden) throw notFound("Activity");

  const canEdit = await hasCapability(tx, req, "activity:update", activity.contextId);
  const now = new Date();
  if (!canEdit) {
    if (activity.availableFrom && activity.availableFrom > now) {
      throw new AppError(403, "NOT_AVAILABLE", `Available from ${activity.availableFrom.toISOString()}`);
    }
    if (activity.availableUntil && activity.availableUntil < now) {
      throw new AppError(403, "NOT_AVAILABLE", "This activity is no longer available");
    }
  }
  if (opts.capability) await requireCapability(tx, req, opts.capability, activity.contextId);
  return { activity, course, canEdit };
}

/** Finds the activity owning a module record (e.g. assignments.activityId) without access checks. */
export async function activityById(tx: DB, activityId: string): Promise<ActivityRow> {
  return must((await tx.select().from(activities).where(eq(activities.id, activityId)).limit(1))[0], "Activity");
}

export async function nextActivityPosition(tx: DB, sectionId: string) {
  const [row] = await tx.select({ max: max(activities.position) }).from(activities).where(eq(activities.sectionId, sectionId));
  return (row?.max ?? -1) + 1;
}

export async function sectionInCourse(tx: DB, sectionId: string, courseId: string) {
  return must(
    (await tx.select().from(courseSections).where(and(eq(courseSections.id, sectionId), eq(courseSections.courseId, courseId))).limit(1))[0],
    "Section",
  );
}
