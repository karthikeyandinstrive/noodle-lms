"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export const PHASES = ["setup", "submission", "assessment", "evaluation", "closed"] as const;
export type Phase = (typeof PHASES)[number];
export const PHASE_LABELS: Record<Phase, string> = {
  setup: "Setup",
  submission: "Submission",
  assessment: "Assessment",
  evaluation: "Evaluation",
  closed: "Closed",
};

export type Criterion = { id: string; description: string; maxScore: number; weight: number };
export type Person = { id: string; firstName: string; lastName: string };
export type FileSummary = { id: string; filename: string; mimeType: string; size: number };

export type Submission = {
  id: string;
  title: string;
  content: string | null;
  files: FileSummary[];
  grade: number | null;
  gradeOverride: number | null;
  createdAt: string;
  updatedAt: string | null;
};

export type WorkshopOverview = {
  phase: Phase;
  instructions: string | null;
  assessmentInstructions: string | null;
  submissionEndAt: string | null;
  assessmentEndAt: string | null;
  submissionGradeMax: number;
  assessmentGradeMax: number;
  reviewsPerSubmission: number;
  allowSelfAssessment: boolean;
  criteria: Criterion[];
  canManage: boolean;
  canSubmit: boolean;
  canAssess: boolean;
  mySubmission: Submission | null;
  myAssessments: { id: string; submissionId: string; submissionTitle: string; isOwn: boolean; submittedAt: string | null; grade: number | null }[];
  myResults: {
    submissionGrade: number | null;
    gradingGrade: number | null;
    total: number | null;
    received: { id: string; grade: number | null; feedback: string | null; scores: Record<string, number> | null }[];
  } | null;
  stats: { participants: number; submissions: number; allocations: number; assessed: number } | null;
};

export type Allocations = {
  submissions: {
    id: string;
    title: string;
    author: Person;
    reviewers: { assessmentId: string; reviewer: Person; submittedAt: string | null; grade: number | null }[];
  }[];
  participants: (Person & { hasSubmission: boolean; reviewing: number })[];
};

export type GradeRow = {
  user: Person;
  submissionId: string | null;
  submissionTitle: string | null;
  submissionGrade: number | null;
  gradeOverride: number | null;
  gradingGrade: number | null;
  total: number | null;
  assessmentsGiven: number;
  assessmentsDone: number;
};

export type AssessmentDetail = {
  id: string;
  submission: Omit<Submission, "grade" | "gradeOverride">;
  isOwnSubmission: boolean;
  criteria: Criterion[];
  scores: Record<string, number> | null;
  feedback: string | null;
  grade: number | null;
  submittedAt: string | null;
  canEdit: boolean;
};

export type SubmissionDetail = Submission & {
  author: Person;
  assessments: { id: string; grade: number | null; feedback: string | null; scores: Record<string, number> | null; reviewer: Person; submittedAt: string | null; gradingGrade: number | null }[];
};

export const workshopKeys = {
  all: (id: string) => ["workshop", id] as const,
  overview: (id: string) => ["workshop", id, "overview"] as const,
  allocations: (id: string) => ["workshop", id, "allocations"] as const,
  grades: (id: string) => ["workshop", id, "grades"] as const,
  assessment: (id: string, assessmentId: string) => ["workshop", id, "assessment", assessmentId] as const,
  submission: (id: string, submissionId: string) => ["workshop", id, "submission", submissionId] as const,
};

export const useWorkshop = (id: string) =>
  useQuery({ queryKey: workshopKeys.overview(id), queryFn: () => api<WorkshopOverview>(`/workshops/${id}`) });

export const useAllocations = (id: string, enabled = true) =>
  useQuery({ queryKey: workshopKeys.allocations(id), queryFn: () => api<Allocations>(`/workshops/${id}/allocations`), enabled });

export const useWorkshopGrades = (id: string, enabled = true) =>
  useQuery({ queryKey: workshopKeys.grades(id), queryFn: () => api<GradeRow[]>(`/workshops/${id}/grades`), enabled });

export const useAssessment = (id: string, assessmentId: string) =>
  useQuery({ queryKey: workshopKeys.assessment(id, assessmentId), queryFn: () => api<AssessmentDetail>(`/workshops/${id}/assessments/${assessmentId}`) });

export const useSubmissionDetail = (id: string, submissionId: string | null) =>
  useQuery({
    queryKey: workshopKeys.submission(id, submissionId ?? ""),
    queryFn: () => api<SubmissionDetail>(`/workshops/${id}/submissions/${submissionId}`),
    enabled: !!submissionId,
  });

/** Client-side preview of the normalized 0–100 grade (the server computes the stored value). */
export function previewGrade(criteria: Criterion[], scores: Record<string, number | undefined>) {
  let w = 0;
  let sum = 0;
  for (const c of criteria) {
    const s = scores[c.id];
    if (s === undefined || Number.isNaN(s)) return null;
    sum += c.weight * (c.maxScore > 0 ? Math.min(Math.max(s, 0), c.maxScore) / c.maxScore : 0);
    w += c.weight;
  }
  return w > 0 ? (sum / w) * 100 : null;
}

export const fmt = (n: number | null | undefined, dp = 2) => (n === null || n === undefined ? "—" : String(Math.round(n * 10 ** dp) / 10 ** dp));
