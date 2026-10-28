import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { activityCompletions, badgeIssues, badges, courseCompletions, withTenant, type BadgeCriteria, type DB } from "@lms/db";
import { randomToken } from "../../core/crypto";
import { emit, on } from "../../core/events";
import { enqueue } from "../../core/jobs";
import { notify } from "../../core/notify";
import { COMPLETED_STATES, isTriggeredBy, meetsCriteria } from "./criteria";

export type BadgeRow = typeof badges.$inferSelect;
export type BadgeIssueRow = typeof badgeIssues.$inferSelect;

export function badgeStatus(issue: Pick<BadgeIssueRow, "revokedAt" | "expiresAt">, now = new Date()) {
  if (issue.revokedAt) return "revoked" as const;
  if (issue.expiresAt && issue.expiresAt < now) return "expired" as const;
  return "valid" as const;
}

/**
 * Awards a badge (idempotent). A revoked issue is reinstated only when `reinstate`
 * is set (manual award). Returns the new/reinstated issue or null if nothing changed.
 * The caller emits `badge.awarded` after commit.
 */
export async function awardBadge(
  tx: DB,
  input: { badge: BadgeRow; userId: string; issuedBy?: string | null; reinstate?: boolean },
): Promise<BadgeIssueRow | null> {
  const { badge, userId } = input;
  const [existing] = await tx
    .select()
    .from(badgeIssues)
    .where(and(eq(badgeIssues.badgeId, badge.id), eq(badgeIssues.userId, userId)))
    .limit(1);
  const now = new Date();
  const expiresAt = badge.expiresAfterDays ? new Date(now.getTime() + badge.expiresAfterDays * 86_400_000) : null;
  let row: BadgeIssueRow;
  if (existing) {
    if (!existing.revokedAt || !input.reinstate) return null;
    [row] = (await tx
      .update(badgeIssues)
      .set({ revokedAt: null, issuedAt: now, expiresAt, issuedBy: input.issuedBy ?? null })
      .where(eq(badgeIssues.id, existing.id))
      .returning()) as [BadgeIssueRow];
  } else {
    [row] = (await tx
      .insert(badgeIssues)
      .values({
        organizationId: badge.organizationId,
        badgeId: badge.id,
        userId,
        uniqueHash: randomToken(24),
        issuedBy: input.issuedBy ?? null,
        issuedAt: now,
        expiresAt,
      })
      .returning()) as [BadgeIssueRow];
  }
  await notify(tx, {
    organizationId: badge.organizationId,
    userIds: [userId],
    type: "badge_awarded",
    title: `You earned the badge "${badge.name}"`,
    body: badge.description.slice(0, 500),
    link: "/achievements",
  });
  return row;
}

/** Evaluates automatic badges for one learner after a course or activity completion. */
async function evaluateAutoBadges(
  organizationId: string,
  userId: string,
  event: { courseId: string; courseCompleted?: string; activityCompleted?: string },
) {
  const awarded = await withTenant(organizationId, async (tx) => {
    // Course badges of this course, plus site badges (course_completion of any course).
    const candidates = (
      await tx
        .select()
        .from(badges)
        .where(and(eq(badges.status, "active"), or(eq(badges.courseId, event.courseId), isNull(badges.courseId))))
    ).filter((b) => isTriggeredBy(b.criteria, event));
    if (!candidates.length) return [];

    const activityIds = [...new Set(candidates.flatMap((b) => (b.criteria.type === "activities" ? b.criteria.activityIds : [])))];
    const courseIds = [...new Set(candidates.flatMap((b) => (b.criteria.type === "course_completion" ? [b.criteria.courseId] : [])))];
    const [doneActivities, doneCourses] = await Promise.all([
      activityIds.length
        ? tx
            .select({ id: activityCompletions.activityId })
            .from(activityCompletions)
            .where(and(eq(activityCompletions.userId, userId), inArray(activityCompletions.activityId, activityIds), inArray(activityCompletions.state, [...COMPLETED_STATES])))
        : Promise.resolve([] as { id: string }[]),
      courseIds.length
        ? tx
            .select({ id: courseCompletions.courseId })
            .from(courseCompletions)
            .where(and(eq(courseCompletions.userId, userId), inArray(courseCompletions.courseId, courseIds)))
        : Promise.resolve([] as { id: string }[]),
    ]);
    const progress = { completedActivityIds: new Set(doneActivities.map((r) => r.id)), completedCourseIds: new Set(doneCourses.map((r) => r.id)) };

    const out: { badge: BadgeRow; issue: BadgeIssueRow }[] = [];
    for (const badge of candidates) {
      if (!meetsCriteria(badge.criteria, progress)) continue;
      const issue = await awardBadge(tx, { badge, userId });
      if (issue) out.push({ badge, issue });
    }
    return out;
  });
  for (const { badge } of awarded) {
    await emit("badge.awarded", { organizationId, userId, badgeId: badge.id, courseId: badge.courseId });
  }
}

export function setupBadges() {
  // Badge images: component "badge" access (any signed-in member) is registered by the files module.
  on("course.completed", async (_tx, p) => {
    enqueue("badges:course-completed", () => evaluateAutoBadges(p.organizationId, p.userId, { courseId: p.courseId, courseCompleted: p.courseId }));
  });
  on("activity.completed", async (_tx, p) => {
    if (!(COMPLETED_STATES as readonly string[]).includes(p.state)) return;
    enqueue("badges:activity-completed", () => evaluateAutoBadges(p.organizationId, p.userId, { courseId: p.courseId, activityCompleted: p.activityId }));
  });
}

export type { BadgeCriteria };
