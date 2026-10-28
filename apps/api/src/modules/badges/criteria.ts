import { createHash } from "node:crypto";
import type { BadgeCriteria } from "@lms/db";

/** Pure badge logic: criteria evaluation and Open Badges 2.0 documents (unit-tested). */

export type LearnerProgress = {
  completedCourseIds: ReadonlySet<string>;
  /** Activities in a completed state (complete / complete_pass). */
  completedActivityIds: ReadonlySet<string>;
};

export const COMPLETED_STATES = ["complete", "complete_pass"] as const;

/** Whether the learner meets an automatic criterion. Manual badges are never auto-awarded. */
export function meetsCriteria(criteria: BadgeCriteria, progress: LearnerProgress): boolean {
  switch (criteria.type) {
    case "manual":
      return false;
    case "course_completion":
      return progress.completedCourseIds.has(criteria.courseId);
    case "activities":
      return criteria.activityIds.length > 0 && criteria.activityIds.every((id) => progress.completedActivityIds.has(id));
    default:
      return false;
  }
}

/** Badges whose criteria could be affected by an event (cheap pre-filter before loading progress). */
export function isTriggeredBy(criteria: BadgeCriteria, event: { courseCompleted?: string; activityCompleted?: string }) {
  if (criteria.type === "course_completion") return !!event.courseCompleted && criteria.courseId === event.courseCompleted;
  if (criteria.type === "activities") return !!event.activityCompleted && criteria.activityIds.includes(event.activityCompleted);
  return false;
}

export function describeCriteria(criteria: BadgeCriteria, names: { course?: string; activities?: string[] } = {}) {
  switch (criteria.type) {
    case "manual":
      return "Awarded manually by a teacher or administrator.";
    case "course_completion":
      return `Complete the course${names.course ? ` "${names.course}"` : ""}.`;
    case "activities":
      return names.activities?.length
        ? `Complete all of these activities: ${names.activities.join(", ")}.`
        : `Complete ${criteria.activityIds.length} required activit${criteria.activityIds.length === 1 ? "y" : "ies"}.`;
  }
}

/** Open Badges hashed recipient identity: "sha256$" + hex(sha256(email + salt)). */
export function hashedIdentity(email: string, salt: string) {
  return `sha256$${createHash("sha256").update(email.trim().toLowerCase() + salt).digest("hex")}`;
}

export type AssertionInput = {
  baseUrl: string;
  uniqueHash: string;
  salt: string;
  recipientEmail: string;
  issuedOn: Date;
  expires: Date | null;
  badge: { id: string; name: string; description: string; criteriaNarrative: string; hasImage: boolean };
  issuer: { name: string; url: string };
};

/** Builds an Open Badges 2.0 hosted Assertion with an embedded BadgeClass and issuer Profile. */
export function buildAssertion(a: AssertionInput) {
  const base = a.baseUrl.replace(/\/+$/, "");
  const assertionUrl = `${base}/api/v1/badges/assertions/${a.uniqueHash}`;
  return {
    "@context": "https://w3id.org/openbadges/v2",
    type: "Assertion",
    id: assertionUrl,
    recipient: { type: "email", hashed: true, salt: a.salt, identity: hashedIdentity(a.recipientEmail, a.salt) },
    badge: {
      type: "BadgeClass",
      id: `${base}/api/v1/badges/classes/${a.badge.id}`,
      name: a.badge.name,
      description: a.badge.description,
      ...(a.badge.hasImage ? { image: `${base}/api/v1/badges/classes/${a.badge.id}/image` } : {}),
      criteria: { narrative: a.badge.criteriaNarrative },
      issuer: { type: "Profile", id: `${base}/api/v1/badges/issuer`, name: a.issuer.name, url: a.issuer.url },
    },
    verification: { type: "hosted" },
    issuedOn: a.issuedOn.toISOString(),
    ...(a.expires ? { expires: a.expires.toISOString() } : {}),
    evidence: `${base}/badges/${a.uniqueHash}`,
  };
}
