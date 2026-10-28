import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { enrolments, groupMembers, groups, roleAssignments, roles, users, type DB } from "@lms/db";

/**
 * Course-people helpers shared by the forum, workshop and attendance modules
 * (enrolled learners, staff, group membership). All take the caller's `tx`.
 */

type CourseRef = { id: string; contextId: string };

/** Every actively enrolled user of a course. */
export async function activeParticipantIds(tx: DB, courseId: string) {
  const rows = await tx
    .select({ userId: enrolments.userId })
    .from(enrolments)
    .where(and(eq(enrolments.courseId, courseId), eq(enrolments.status, "active")));
  return rows.map((r) => r.userId);
}

/** Actively enrolled users holding a student-archetype role in the course context. */
export async function learnerIds(tx: DB, course: CourseRef) {
  const rows = await tx
    .selectDistinct({ userId: enrolments.userId })
    .from(enrolments)
    .innerJoin(roleAssignments, and(eq(roleAssignments.userId, enrolments.userId), eq(roleAssignments.contextId, course.contextId)))
    .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
    .where(and(eq(enrolments.courseId, course.id), eq(enrolments.status, "active"), eq(roles.archetype, "student")));
  return rows.map((r) => r.userId);
}

/** Actively enrolled users holding any non-student role (teachers, managers…) in the course context. */
export async function staffIds(tx: DB, course: CourseRef) {
  const rows = await tx
    .selectDistinct({ userId: enrolments.userId })
    .from(enrolments)
    .innerJoin(roleAssignments, and(eq(roleAssignments.userId, enrolments.userId), eq(roleAssignments.contextId, course.contextId)))
    .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
    .where(and(eq(enrolments.courseId, course.id), eq(enrolments.status, "active"), ne(roles.archetype, "student"), ne(roles.archetype, "guest")));
  return rows.map((r) => r.userId);
}

/** Ids of the course groups a user belongs to. */
export async function userGroupIds(tx: DB, courseId: string, userId: string) {
  const rows = await tx
    .select({ id: groups.id })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .where(and(eq(groups.courseId, courseId), eq(groupMembers.userId, userId)));
  return rows.map((r) => r.id);
}

export async function groupMemberIds(tx: DB, groupId: string) {
  const rows = await tx.select({ userId: groupMembers.userId }).from(groupMembers).where(eq(groupMembers.groupId, groupId));
  return rows.map((r) => r.userId);
}

export async function courseGroups(tx: DB, courseId: string) {
  return tx.select({ id: groups.id, name: groups.name }).from(groups).where(eq(groups.courseId, courseId)).orderBy(asc(groups.name));
}

export async function groupInCourse(tx: DB, groupId: string, courseId: string) {
  const [g] = await tx.select({ id: groups.id }).from(groups).where(and(eq(groups.id, groupId), eq(groups.courseId, courseId))).limit(1);
  return !!g;
}

export type PersonSummary = { id: string; firstName: string; lastName: string };

export async function userSummaries(tx: DB, ids: string[]): Promise<Map<string, PersonSummary>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const rows = await tx
    .select({ id: users.id, firstName: users.firstName, lastName: users.lastName })
    .from(users)
    .where(inArray(users.id, unique));
  return new Map(rows.map((r) => [r.id, r]));
}

/** Plain-text excerpt of sanitized HTML (for notifications and search results; rendered as text). */
export function htmlExcerpt(html: string, max = 200) {
  const text = html
    .replace(/<(br|\/p|\/div|\/li|\/h\d)[^>]*>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Escapes LIKE wildcards in user input. */
export function likeEscape(value: string) {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}
