"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Translate } from "@/lib/i18n";

export type QuestionType = "multichoice" | "truefalse" | "shortanswer" | "numerical" | "essay" | "matching" | "calculated" | "gapselect";
export type GradeMethod = "highest" | "average" | "first" | "last";
export type ReviewOptions = { marks: boolean; correctness: boolean; feedback: boolean; rightAnswer: boolean };

export type QuizSettings = {
  intro: string | null;
  openAt: string | null;
  closeAt: string | null;
  timeLimitSeconds: number | null;
  attemptsAllowed: number;
  gradeMethod: GradeMethod;
  gradeMax: number;
  gradePass: number | null;
  shuffleQuestions: boolean;
  shuffleAnswers: boolean;
  reviewOptions: ReviewOptions;
};

export type AttemptSummary = {
  id: string;
  attempt: number;
  preview: boolean;
  status: "in_progress" | "finished" | "abandoned";
  startedAt: string;
  dueAt: string | null;
  finishedAt: string | null;
  needsGrading: boolean;
  sumMarks?: number | null;
  grade?: number | null;
};

export type QuizSummary = Omit<QuizSettings, "shuffleQuestions" | "shuffleAnswers" | "reviewOptions"> & {
  questionCount: number;
  totalMarks: number;
  attempts: AttemptSummary[];
  inProgressAttemptId: string | null;
  canStart: boolean;
  reason: string | null;
  isPreview: boolean;
  myGrade: number | null;
  capabilities: Record<string, boolean>;
};

export type QuestionView =
  | { type: "multichoice"; single: boolean; options: { id: string; text: string }[] }
  | { type: "truefalse" }
  | { type: "shortanswer" }
  | { type: "numerical" }
  | { type: "essay"; responseTemplate: string | null; minWords: number | null }
  | { type: "matching"; stems: { id: string; text: string }[]; choices: string[] }
  | { type: "calculated" }
  | { type: "gapselect"; gaps: { id: string; options: string[] }[] };

export type Response =
  | { selected: string[] }
  | { value: boolean }
  | { text: string }
  | { value: string }
  | { matches: Record<string, string> }
  | { gaps: Record<string, string> }
  | null;

export type AttemptQuestion = {
  slotId: string;
  number: number;
  type: QuestionType;
  name?: string;
  text: string;
  maxMark: number;
  view: QuestionView;
  response: Response;
  state?: "correct" | "partial" | "incorrect" | "needs_grading";
  mark?: number | null;
  feedback?: string | null;
  generalFeedback?: string | null;
  comment?: string | null;
  rightAnswer?: string | null;
};

export type AttemptDetail = {
  attempt: AttemptSummary & { totalMarks: number; gradeMax: number; serverNow: string };
  user: { id: string; firstName: string; lastName: string };
  quiz: { activityId: string; name: string; courseId: string };
  isOwner: boolean;
  isReviewer: boolean;
  canGrade: boolean;
  show: ReviewOptions;
  questions: AttemptQuestion[];
};

export type Slot = {
  id: string;
  position: number;
  /** null for a random slot. */
  questionId: string | null;
  maxMark: number;
  pinnedVersion: number | null;
  latestVersion: number | null;
  name: string;
  type: QuestionType | null;
  deleted: boolean;
  /** Random slot: each attempt draws a question from this category. */
  random: { categoryId: string; categoryName: string; includeSubcategories: boolean; available: number } | null;
};

export type Results = {
  gradeMax: number;
  totalMarks: number;
  attempts: (AttemptSummary & { user: { id: string; firstName: string; lastName: string; email: string } })[];
  questions: {
    slotId: string;
    number: number;
    name: string;
    /** null for random slots. */
    type: QuestionType | null;
    maxMark: number;
    responses: number;
    averageMark: number | null;
    facility: number | null;
    needsGrading: number;
  }[];
};

export const quizKeys = {
  summary: (id: string) => ["quiz", id, "summary"] as const,
  attempt: (id: string, attemptId: string) => ["quiz", id, "attempt", attemptId] as const,
  slots: (id: string) => ["quiz", id, "slots"] as const,
  results: (id: string) => ["quiz", id, "results"] as const,
};

export const useQuizSummary = (activityId: string) =>
  useQuery({ queryKey: quizKeys.summary(activityId), queryFn: () => api<QuizSummary>(`/quizzes/${activityId}`) });

export const useAttempt = (activityId: string, attemptId: string) =>
  useQuery({
    queryKey: quizKeys.attempt(activityId, attemptId),
    queryFn: () => api<AttemptDetail>(`/quizzes/${activityId}/attempts/${attemptId}`),
    // Never refetch in the background while answering: local answers are the source of truth.
    refetchOnWindowFocus: false,
  });

export const useSlots = (activityId: string) =>
  useQuery({ queryKey: quizKeys.slots(activityId), queryFn: () => api<{ slots: Slot[]; locked: boolean }>(`/quizzes/${activityId}/slots`) });

export const useResults = (activityId: string) =>
  useQuery({ queryKey: quizKeys.results(activityId), queryFn: () => api<Results>(`/quizzes/${activityId}/results`) });

export function useStartAttempt(activityId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ attemptId: string; resumed: boolean; preview: boolean }>(`/quizzes/${activityId}/attempts`, { method: "POST", body: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: quizKeys.summary(activityId) }),
  });
}

export function useSlotMutation<T>(activityId: string, fn: (vars: T) => Promise<Slot[]>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (slots) => {
      qc.setQueryData<{ slots: Slot[]; locked: boolean }>(quizKeys.slots(activityId), (old) => ({ locked: old?.locked ?? false, slots }));
      void qc.invalidateQueries({ queryKey: quizKeys.summary(activityId) });
    },
  });
}

export const GRADE_METHOD_LABEL: Record<GradeMethod, string> = {
  highest: "Highest grade",
  average: "Average grade",
  first: "First attempt",
  last: "Last attempt",
};

export const TYPE_LABEL: Record<QuestionType, string> = {
  multichoice: "Multiple choice",
  truefalse: "True/False",
  shortanswer: "Short answer",
  numerical: "Numerical",
  essay: "Essay",
  matching: "Matching",
  calculated: "Calculated",
  gapselect: "Select missing words",
};

/** Translated grading-method label (keys: quiz.gradeMethod.*). */
export const gradeMethodLabel = (t: Translate, m: GradeMethod) => t(`quiz.gradeMethod.${m}`, GRADE_METHOD_LABEL[m]);

/** Translated question-type label (keys: quiz.type.*). */
export const typeLabel = (t: Translate, type: QuestionType) => t(`quiz.type.${type}`, TYPE_LABEL[type]);

export function formatDuration(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

export const round = (n: number | null | undefined, d = 2) => (n == null ? "—" : String(Math.round(n * 10 ** d) / 10 ** d));
