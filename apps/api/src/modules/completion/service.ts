import { and, asc, eq, inArray } from "drizzle-orm";
import {
  activities,
  activityCompletions,
  courseCompletions,
  courseSections,
  courses,
  enrolments,
  roleAssignments,
  roles,
  type DB,
} from "@lms/db";
import { notify } from "../../core/notify";
import type { FollowUp } from "./follow-ups";
import { courseProgress, isDone, type CompletionRule, type CompletionState } from "./rules";

type ActivityRow = typeof activities.$inferSelect;
type CourseRow = typeof courses.$inferSelect;

/** Activity + course, or null when completion tracking is off for the course or the activity has no rule. */
export async function trackedActivity(tx: DB, activityId: string) {
  const [row] = await tx
    .select({ activity: activities, course: courses })
    .from(activities)
    .innerJoin(courses, eq(courses.id, activities.courseId))
    .where(eq(activities.id, activityId))
    .limit(1);
  if (!row || !row.course.enableCompletion || row.activity.completionRule === "none") return null;
  return row;
}

/** Completion is only tracked for active participants of the course. */
export async function isActiveParticipant(tx: DB, courseId: string, userId: string) {
  const [row] = await tx
    .select({ status: enrolments.status })
    .from(enrolments)
    .where(and(eq(enrolments.courseId, courseId), eq(enrolments.userId, userId)))
    .limit(1);
  return row?.status === "active";
}

/** Learners (student role, active enrolment) — the only users who can complete a course. */
async function isLearner(tx: DB, course: CourseRow, userId: string) {
  const [row] = await tx
    .select({ id: roleAssignments.id })
    .from(roleAssignments)
    .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
    .where(and(eq(roleAssignments.userId, userId), eq(roleAssignments.contextId, course.contextId), eq(roles.archetype, "student")))
    .limit(1);
  return !!row && (await isActiveParticipant(tx, course.id, userId));
}

/**
 * Upserts a learner's activity completion.
 *
 * Automatic updates (events) never change a state a teacher has overridden; they still record the
 * first view. Returns the follow-up `activity.completed` event when the state changed to a completed one.
 */
export async function setActivityCompletion(
  tx: DB,
  input: {
    activity: ActivityRow;
    userId: string;
    /** null = only record the view. */
    state: CompletionState | null;
    viewed?: boolean;
    /** Set for teacher overrides; clears to null for learner/automatic changes. */
    overriddenBy?: string | null;
    automatic: boolean;
  },
): Promise<{ state: CompletionState; changed: boolean; followUps: FollowUp[] }> {
  const { activity, userId } = input;
  const [existing] = await tx
    .select()
    .from(activityCompletions)
    .where(and(eq(activityCompletions.activityId, activity.id), eq(activityCompletions.userId, userId)))
    .limit(1);
  const current = (existing?.state ?? "incomplete") as CompletionState;
  const locked = input.automatic && !!existing?.overriddenBy;
  const next = input.state === null || locked ? current : input.state;
  const changed = next !== current;
  const now = new Date();

  const values = {
    state: next,
    completedAt: changed ? (next === "incomplete" ? null : now) : (existing?.completedAt ?? null),
    viewedAt: existing?.viewedAt ?? (input.viewed ? now : null),
    overriddenBy: input.automatic ? (existing?.overriddenBy ?? null) : (input.overriddenBy ?? null),
  };
  if (existing) {
    if (changed || values.viewedAt !== existing.viewedAt || values.overriddenBy !== existing.overriddenBy) {
      await tx.update(activityCompletions).set(values).where(eq(activityCompletions.id, existing.id));
    }
  } else if (changed || input.viewed || !input.automatic) {
    await tx.insert(activityCompletions).values({ ...values, organizationId: activity.organizationId, activityId: activity.id, userId });
  }

  const followUps: FollowUp[] = [];
  if (changed) {
    followUps.push({
      name: "activity.completed",
      payload: { organizationId: activity.organizationId, activityId: activity.id, courseId: activity.courseId, userId, state: next },
    });
  }
  return { state: next, changed, followUps };
}

/** Activities counted for course completion: a rule, visible, in a visible section. */
export async function trackedCourseActivities(tx: DB, courseId: string) {
  const rows = await tx
    .select({ a: activities })
    .from(activities)
    .innerJoin(courseSections, eq(courseSections.id, activities.sectionId))
    .where(and(eq(activities.courseId, courseId), eq(activities.visible, true), eq(courseSections.visible, true)))
    .orderBy(asc(courseSections.position), asc(activities.position));
  return rows.map((r) => r.a).filter((a) => a.completionRule !== "none");
}

export async function statesFor(tx: DB, userId: string, activityIds: string[]) {
  if (!activityIds.length) return new Map<string, CompletionState>();
  const rows = await tx
    .select({ activityId: activityCompletions.activityId, state: activityCompletions.state })
    .from(activityCompletions)
    .where(and(eq(activityCompletions.userId, userId), inArray(activityCompletions.activityId, activityIds)));
  return new Map(rows.map((r) => [r.activityId, r.state as CompletionState]));
}

/**
 * Marks the course complete for a learner once every tracked activity is complete (complete_fail
 * does not count). Course completion is permanent: later changes do not revoke it.
 * Notifies the learner and returns the `course.completed` follow-up when newly completed.
 */
export async function evaluateCourseCompletion(tx: DB, course: CourseRow, userId: string): Promise<FollowUp[]> {
  if (!course.enableCompletion) return [];
  const [already] = await tx
    .select({ id: courseCompletions.id })
    .from(courseCompletions)
    .where(and(eq(courseCompletions.courseId, course.id), eq(courseCompletions.userId, userId)))
    .limit(1);
  if (already) return [];
  const tracked = await trackedCourseActivities(tx, course.id);
  const progress = courseProgress(
    tracked.map((a) => ({ id: a.id, completionRule: a.completionRule as CompletionRule })),
    await statesFor(tx, userId, tracked.map((a) => a.id)),
  );
  if (!progress.complete || !(await isLearner(tx, course, userId))) return [];

  const [inserted] = await tx
    .insert(courseCompletions)
    .values({ organizationId: course.organizationId, courseId: course.id, userId, data: { activities: progress.total } })
    .onConflictDoNothing()
    .returning();
  if (!inserted) return [];
  await notify(tx, {
    organizationId: course.organizationId,
    userIds: [userId],
    type: "course_completed",
    title: `You completed ${course.fullname}`,
    body: "Congratulations! You have completed every activity in this course.",
    link: `/courses/${course.id}`,
  });
  return [{ name: "course.completed", payload: { organizationId: course.organizationId, courseId: course.id, userId } }];
}

/** Applies an automatic (event-driven) state and evaluates the course. Used by the subscribers. */
export async function applyAutomatic(
  tx: DB,
  input: { activityId: string; userId: string; state: CompletionState | null; viewed?: boolean },
): Promise<FollowUp[]> {
  const row = await trackedActivity(tx, input.activityId);
  if (!row) return [];
  if (!(await isActiveParticipant(tx, row.course.id, input.userId))) return [];
  const result = await setActivityCompletion(tx, { activity: row.activity, userId: input.userId, state: input.state, viewed: input.viewed, automatic: true });
  if (!result.changed) return [];
  const course = isDone(result.state) ? await evaluateCourseCompletion(tx, row.course, input.userId) : [];
  return [...result.followUps, ...course];
}
