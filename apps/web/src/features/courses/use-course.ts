"use client";

import { useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { api } from "@/lib/api";
import type { CourseOverview } from "@/lib/types";

export const courseKey = (id: string) => ["course", id] as const;

/** Course overview for the current /courses/[courseId] route (shared cache across course pages). */
export function useCourse() {
  const { courseId } = useParams<{ courseId: string }>();
  const query = useQuery({ queryKey: courseKey(courseId), queryFn: () => api<CourseOverview>(`/courses/${courseId}`) });
  return { courseId, ...query, can: (cap: string) => query.data?.capabilities[cap] === true };
}
