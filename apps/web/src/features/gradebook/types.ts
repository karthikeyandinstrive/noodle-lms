/** Shapes returned by the gradebook API (/api/v1/grades). */

import type { Translate } from "@/lib/i18n";

export type Aggregation = "mean" | "weighted_mean" | "sum" | "highest" | "lowest" | "median";
export type GradeItemType = "activity" | "manual" | "category" | "course";

export type GradeItem = {
  id: string;
  categoryId: string | null;
  type: GradeItemType;
  activityId: string | null;
  name: string;
  gradeMax: number;
  gradeMin: number;
  gradePass: number | null;
  weight: number;
  hidden: boolean;
  locked: boolean;
  position: number;
};

export type GradeCategory = {
  id: string;
  parentId: string | null;
  name: string;
  aggregation: Aggregation;
  dropLowest: number;
  itemId: string | null;
  weight: number | null;
};

export type Grade = {
  itemId: string;
  userId: string;
  rawGrade: number | null;
  finalGrade: number | null;
  overridden: boolean;
  feedback: string | null;
  updatedAt: string;
};

export type GradebookUser = { id: string; firstName: string; lastName: string; email?: string };

export type GraderReport = {
  course: { id: string; fullname: string };
  categories: GradeCategory[];
  items: GradeItem[];
  users: { items: GradebookUser[]; total: number; page: number; pageSize: number };
  grades: Grade[];
  capabilities: { edit: boolean; export: boolean };
};

export type UserReportRow = Pick<GradeItem, "id" | "type" | "activityId" | "name" | "gradeMax" | "gradeMin" | "gradePass" | "weight" | "categoryId"> & {
  grade: number | null;
  percentage: number | null;
  feedback: string | null;
  overridden: boolean;
  hidden: boolean;
};

export type UserReport = {
  course: { id: string; fullname: string };
  user: GradebookUser;
  categories: GradeCategory[];
  items: UserReportRow[];
  courseTotal: { grade: number | null; gradeMax: number; percentage: number | null } | null;
};

export type MyCourseGrade = {
  course: { id: string; fullname: string; shortname: string };
  grade: number | null;
  gradeMax: number | null;
  percentage: number | null;
};

export type GradeHistoryEntry = {
  id: string;
  oldGrade: number | null;
  newGrade: number | null;
  source: string;
  changedAt: string;
  changedBy: GradebookUser | null;
};

export const AGGREGATION_LABELS: Record<Aggregation, string> = {
  weighted_mean: "Weighted mean",
  mean: "Mean",
  sum: "Natural (sum of points)",
  highest: "Highest grade",
  lowest: "Lowest grade",
  median: "Median",
};

/** Translated aggregation label (English fallback from AGGREGATION_LABELS). */
export function aggregationLabel(t: Translate, a: Aggregation) {
  return t(`grades.aggregation.${a}`, AGGREGATION_LABELS[a]);
}

export const gradesKey = (courseId: string) => ["grades", courseId] as const;

/** Formats a grade with at most 2 decimals; "–" when empty. */
export function fmtGrade(value: number | null | undefined, locale?: string) {
  if (value === null || value === undefined) return "–";
  return (Math.round(value * 100) / 100).toLocaleString(locale, { maximumFractionDigits: 2 });
}

export function fmtPercent(value: number | null | undefined, locale?: string) {
  if (value === null || value === undefined) return "–";
  return (Math.round(value * 10) / 1000).toLocaleString(locale, { style: "percent", maximumFractionDigits: 1 });
}
