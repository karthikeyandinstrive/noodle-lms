"use client";

import { useQueries, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { progressKey, type MyProgress } from "./types";

export function useMyProgress(courseId: string, enabled = true) {
  return useQuery({ queryKey: progressKey(courseId), queryFn: () => api<MyProgress>(`/completion/courses/${courseId}/me`), enabled });
}

/** Progress of several courses at once (dashboard). Returns a map courseId → progress. */
export function useProgressMap(courseIds: string[]) {
  const results = useQueries({
    queries: courseIds.map((id) => ({ queryKey: progressKey(id), queryFn: () => api<MyProgress>(`/completion/courses/${id}/me`), staleTime: 30_000 })),
  });
  return new Map(courseIds.map((id, i) => [id, results[i]?.data]));
}
