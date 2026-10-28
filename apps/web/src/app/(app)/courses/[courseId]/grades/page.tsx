"use client";

import { EmptyState } from "@/components/common";
import { useCourse } from "@/features/courses/use-course";
import { GraderReportView } from "@/features/gradebook/grader-report";
import { MyCourseGrades } from "@/features/gradebook/user-report";
import { useT } from "@/lib/i18n";

export default function CourseGradesPage() {
  const { courseId, data, can } = useCourse();
  const t = useT();
  if (!data) return null;
  if (can("grades:view_all")) return <GraderReportView courseId={courseId} canSetup={can("grades:edit")} />;
  if (can("grades:view_own")) return <MyCourseGrades courseId={courseId} />;
  return (
    <EmptyState
      title={t("course.gradesUnavailable", "Grades are not available")}
      description={t("course.noPermissionGrades", "You don't have permission to view grades in this course.")}
    />
  );
}
