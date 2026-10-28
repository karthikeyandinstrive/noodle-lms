"use client";

import { EmptyState } from "@/components/common";
import { CompletionMatrix } from "@/features/completion/completion-matrix";
import { useCourse } from "@/features/courses/use-course";

export default function CourseCompletionPage() {
  const { courseId, data, can } = useCourse();
  if (!data) return null;
  if (!can("report:view_course")) return <EmptyState title="Completion report is not available" description="You don't have permission to view course reports." />;
  return <CompletionMatrix courseId={courseId} />;
}
