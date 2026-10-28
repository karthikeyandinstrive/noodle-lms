"use client";

import { useQuery } from "@tanstack/react-query";
import { api, type Paged } from "@/lib/api";
import type { QuestionType } from "../quiz/api";

export type Category = { id: string; courseId: string | null; parentId: string | null; name: string; questionCount: number; canEdit: boolean };

export type QuestionSummary = {
  id: string;
  categoryId: string;
  latestVersion: number;
  type: QuestionType;
  name: string;
  defaultMark: number;
  createdAt: string;
  updatedAt: string;
};

export type MultichoiceData = { single: boolean; options: { id: string; text: string; fraction: number; feedback: string }[] };
export type TruefalseData = { correct: boolean };
export type ShortanswerData = { caseSensitive: boolean; answers: { text: string; fraction: number }[] };
export type NumericalData = { answers: { value: number; tolerance: number; fraction: number }[] };
export type EssayData = { responseTemplate?: string; minWords?: number };
export type MatchingData = { pairs: { id: string; question: string; answer: string }[] };

export type QuestionData = {
  multichoice: MultichoiceData;
  truefalse: TruefalseData;
  shortanswer: ShortanswerData;
  numerical: NumericalData;
  essay: EssayData;
  matching: MatchingData;
};

export type QuestionInput = {
  [K in QuestionType]: { type: K; name: string; text: string; defaultMark: number; generalFeedback: string | null; data: QuestionData[K] };
}[QuestionType];

export type QuestionVersion = {
  id: string;
  questionId: string;
  version: number;
  type: QuestionType;
  name: string;
  text: string;
  defaultMark: number;
  data: Record<string, unknown>;
  generalFeedback: string | null;
  createdBy: { id: string; firstName: string; lastName: string } | null;
  createdAt: string;
};

export type QuestionDetail = { id: string; categoryId: string; latestVersion: number; current: QuestionVersion };

export const bankKeys = {
  all: ["question-bank"] as const,
  categories: (courseId: string) => ["question-bank", "categories", courseId] as const,
  questions: (categoryId: string, params: Record<string, unknown>) => ["question-bank", "questions", categoryId, params] as const,
  question: (id: string) => ["question-bank", "question", id] as const,
  versions: (id: string) => ["question-bank", "versions", id] as const,
};

export const useBankPermissions = (courseId: string) =>
  useQuery({
    queryKey: ["question-bank", "permissions", courseId] as const,
    queryFn: () => api<{ course: boolean; shared: boolean }>("/question-bank/permissions", { query: { courseId } }),
    staleTime: 60_000,
  });

export const useCategories = (courseId: string) =>
  useQuery({ queryKey: bankKeys.categories(courseId), queryFn: () => api<Category[]>("/question-bank/categories", { query: { courseId } }) });

export const useQuestions = (categoryId: string | null, courseId: string, params: { page: number; search?: string; type?: string }) =>
  useQuery({
    queryKey: bankKeys.questions(categoryId ?? "", { ...params, courseId }),
    queryFn: () =>
      api<Paged<QuestionSummary>>(`/question-bank/categories/${categoryId}/questions`, {
        query: { courseId, page: params.page, pageSize: 25, search: params.search, type: params.type },
      }),
    enabled: !!categoryId,
  });

export const useQuestion = (id: string | null, courseId: string) =>
  useQuery({
    queryKey: bankKeys.question(id ?? ""),
    queryFn: () => api<QuestionDetail>(`/question-bank/questions/${id}`, { query: { courseId } }),
    enabled: !!id,
  });

export const useVersions = (id: string | null, courseId: string) =>
  useQuery({
    queryKey: bankKeys.versions(id ?? ""),
    queryFn: () => api<QuestionVersion[]>(`/question-bank/questions/${id}/versions`, { query: { courseId } }),
    enabled: !!id,
  });

export const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);

export function emptyQuestion(type: QuestionType): QuestionInput {
  const base = { name: "", text: "", defaultMark: 1, generalFeedback: null };
  switch (type) {
    case "multichoice":
      return {
        ...base,
        type,
        data: {
          single: true,
          options: [
            { id: newId(), text: "", fraction: 1, feedback: "" },
            { id: newId(), text: "", fraction: 0, feedback: "" },
            { id: newId(), text: "", fraction: 0, feedback: "" },
          ],
        },
      };
    case "truefalse":
      return { ...base, type, data: { correct: true } };
    case "shortanswer":
      return { ...base, type, data: { caseSensitive: false, answers: [{ text: "", fraction: 1 }] } };
    case "numerical":
      return { ...base, type, data: { answers: [{ value: 0, tolerance: 0, fraction: 1 }] } };
    case "essay":
      return { ...base, type, data: {} };
    case "matching":
      return {
        ...base,
        type,
        data: {
          pairs: [
            { id: newId(), question: "", answer: "" },
            { id: newId(), question: "", answer: "" },
            { id: newId(), question: "", answer: "" },
          ],
        },
      };
  }
}
