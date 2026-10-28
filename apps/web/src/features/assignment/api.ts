"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

export type SubmissionStatus = "draft" | "submitted" | "graded" | "reopened";
export type SubmissionFile = { id: string; filename: string; mimeType: string; size: number };
export type Submission = {
  id: string;
  attempt: number;
  status: SubmissionStatus;
  text: string | null;
  submittedAt: string | null;
  late: boolean;
  createdAt: string;
  updatedAt: string;
  files: SubmissionFile[];
};
export type Feedback = {
  grade: number | null;
  feedback: string | null;
  gradedAt: string;
  attempt: number;
  grader?: { id: string; firstName: string; lastName: string } | null;
};
export type AttemptSummary = { id: string; attempt: number; status: SubmissionStatus; submittedAt: string | null; late: boolean };

export type MyStatus = {
  submission: Submission | null;
  feedback: Feedback | null;
  canSubmitCapability: boolean;
  canEdit: boolean;
  canSubmit: boolean;
  reason: string | null;
  dueAt: string | null;
  cutoffAt: string | null;
  serverNow: string;
};

export type Participant = {
  userId: string;
  displayName: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  participantNumber?: number;
};

export type SubmissionList = {
  blindMarking: boolean;
  gradeMax: number;
  dueAt: string | null;
  counts: { participants: number; submitted: number; needsGrading: number; graded: number };
  items: (Participant & { submission: AttemptSummary | null; grade: number | null; gradedAt: string | null; needsGrading: boolean })[];
};

export type SubmissionDetail = {
  participant: Participant;
  submission: Submission | null;
  feedback: Feedback | null;
  attempts: AttemptSummary[];
  gradeMax: number;
  blindMarking: boolean;
  canGrade: boolean;
};

/** Settings as returned by the activity (`activity.settings`). */
export type AssignmentSettings = {
  instructions: string | null;
  allowText: boolean;
  allowFiles: boolean;
  maxFiles: number;
  maxFileBytes: number;
  acceptedTypes: string[];
  dueAt: string | null;
  cutoffAt: string | null;
  allowResubmit: boolean;
  gradeMax: number;
  gradePass: number | null;
  blindMarking: boolean;
};

export const assignmentKeys = {
  me: (id: string) => ["assignment", id, "me"] as const,
  list: (id: string) => ["assignment", id, "submissions"] as const,
  detail: (id: string, userId: string) => ["assignment", id, "submissions", userId] as const,
};

export function useMyAssignment(activityId: string, enabled = true) {
  return useQuery({ queryKey: assignmentKeys.me(activityId), queryFn: () => api<MyStatus>(`/assignments/${activityId}/me`), enabled });
}

export function useSubmissions(activityId: string, enabled = true) {
  return useQuery({ queryKey: assignmentKeys.list(activityId), queryFn: () => api<SubmissionList>(`/assignments/${activityId}/submissions`), enabled });
}

export function useSubmission(activityId: string, userId: string | null) {
  return useQuery({
    queryKey: assignmentKeys.detail(activityId, userId ?? ""),
    queryFn: () => api<SubmissionDetail>(`/assignments/${activityId}/submissions/${userId}`),
    enabled: !!userId,
  });
}

export function useSaveDraft(activityId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { text: string | null; fileIds: string[] }) => api<Submission>(`/assignments/${activityId}/draft`, { method: "PUT", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: assignmentKeys.me(activityId) }),
  });
}

export function useSubmit(activityId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<Submission>(`/assignments/${activityId}/submit`, { method: "POST", body: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: assignmentKeys.me(activityId) }),
  });
}

export function useGrade(activityId: string, userId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { grade: number | null; feedback: string | null }) =>
      api<Feedback>(`/assignments/${activityId}/submissions/${userId}/grade`, { method: "POST", body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: assignmentKeys.list(activityId) });
      void qc.invalidateQueries({ queryKey: assignmentKeys.detail(activityId, userId) });
    },
  });
}

export function useReopen(activityId: string, userId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<AttemptSummary>(`/assignments/${activityId}/submissions/${userId}/reopen`, { method: "POST", body: {} }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: assignmentKeys.list(activityId) });
      void qc.invalidateQueries({ queryKey: assignmentKeys.detail(activityId, userId) });
    },
  });
}

export const STATUS_LABEL: Record<SubmissionStatus, string> = {
  draft: "Draft (not submitted)",
  submitted: "Submitted",
  graded: "Graded",
  reopened: "Reopened",
};
