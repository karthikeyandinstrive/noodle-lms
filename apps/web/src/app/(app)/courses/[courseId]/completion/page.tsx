"use client";

import { EmptyState } from "@/components/common";
import { CompletionMatrix } from "@/features/completion/completion-matrix";
import { useCourse } from "@/features/courses/use-course";
import { useT } from "@/lib/i18n";

export default function CourseCompletionPage() {
  const { courseId, data, can } = useCourse();
  const t = useT();
  if (!data) return null;
  if (!can("report:view_course")) return (
      <EmptyState
        title={t("completion.reportUnavailable", "Completion report is not available")}
        description={t("course.noPermissionReports", "You don't have permission to view course reports.")}
      />
    );
  return <CompletionMatrix courseId={courseId} />;
}
