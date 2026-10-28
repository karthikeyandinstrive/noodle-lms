import type { UserSummary } from "@/lib/types";
import type { IssueStatus } from "../certificate/shared";

export type BadgeCriteria = { type: "manual" } | { type: "course_completion"; courseId: string } | { type: "activities"; activityIds: string[] };

export type BadgeItem = {
  id: string;
  courseId: string | null;
  name: string;
  description: string;
  imageFileId: string | null;
  criteria: BadgeCriteria;
  criteriaText: string;
  status: string;
  expiresAfterDays: number | null;
  createdAt: string;
};

export type BadgeIssue = { id: string; uniqueHash: string; issuedAt: string; expiresAt: string | null; revokedAt: string | null; status: IssueStatus };

export type ManagedBadge = BadgeItem & { recipients: number };
export type CourseBadge = BadgeItem & { earned: BadgeIssue | null };
export type Recipient = BadgeIssue & { user: UserSummary; issuedBy: string | null };
export type Candidate = UserSummary & { awarded: boolean };
export type MyBadge = BadgeIssue & {
  badge: Pick<BadgeItem, "id" | "name" | "description" | "imageFileId" | "courseId">;
  courseName: string | null;
};

/** Public image URL (works signed-out, used by verification pages and Open Badges consumers). */
export const badgeImageUrl = (badgeId: string) => `/api/v1/badges/classes/${badgeId}/image`;
export const badgePagePath = (hash: string) => `/badges/${hash}`;
export const assertionUrl = (hash: string) => `/api/v1/badges/assertions/${hash}`;
