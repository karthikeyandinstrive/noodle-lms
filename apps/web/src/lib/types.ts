/** Shapes returned by the LMS API (mirror the Zod response schemas in apps/api). */

export type ActivityType =
  | "page"
  | "url"
  | "file"
  | "assignment"
  | "quiz"
  | "forum"
  | "workshop"
  | "attendance"
  | "interactive"
  | "video"
  | "certificate";

export type CompletionRule = "none" | "manual" | "view" | "submit" | "grade" | "pass";

export type Course = {
  id: string;
  categoryId: string | null;
  fullname: string;
  shortname: string;
  summary: string | null;
  format: string;
  visible: boolean;
  startDate: string | null;
  endDate: string | null;
  imageFileId: string | null;
  enableCompletion: boolean;
  selfEnrol: "open" | "key" | "closed";
  priceCents: number | null;
  currency: string | null;
  createdAt: string;
  enrolled?: boolean;
};

export type ActivitySummary = {
  id: string;
  sectionId: string;
  type: ActivityType;
  name: string;
  position: number;
  visible: boolean;
  availableFrom: string | null;
  availableUntil: string | null;
  completionRule: CompletionRule;
  completion: string | null;
};

export type Section = { id: string; title: string; summary: string | null; position: number; visible: boolean; activities: ActivitySummary[] };

export type CourseOverview = {
  course: Course;
  sections: Section[];
  enrolled: boolean;
  capabilities: Record<string, boolean>;
};

export type ActivityDetail = {
  id: string;
  courseId: string;
  sectionId: string;
  contextId: string;
  type: ActivityType;
  name: string;
  description: string | null;
  position: number;
  visible: boolean;
  availableFrom: string | null;
  availableUntil: string | null;
  completionRule: CompletionRule;
  groupMode: string;
  createdAt: string;
  settings: Record<string, unknown> | null;
  capabilities: Record<string, boolean>;
  completion: string | null;
  course: { id: string; fullname: string };
};

export type UserSummary = { id: string; firstName: string; lastName: string; email?: string };
