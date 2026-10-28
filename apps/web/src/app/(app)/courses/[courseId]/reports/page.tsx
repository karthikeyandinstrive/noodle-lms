"use client";

import { EmptyState } from "@/components/common";
import { useCourse } from "@/features/courses/use-course";
import { AnnounceDialog } from "@/features/notifications/announce-dialog";
import { CourseReports } from "@/features/reports/course-reports";
import { useT } from "@/lib/i18n";

export default function CourseReportsPage() {
  const { courseId, data, can } = useCourse();
  const t = useT();
  if (!data) return null;
  if (!can("report:view_course")) return (
      <EmptyState
        title={t("course.reportsUnavailable", "Reports are not available")}
        description={t("course.noPermissionReports", "You don't have permission to view course reports.")}
      />
    );
  return (
    <div className="space-y-4">
      {can("notification:send") && (
        <div className="flex justify-end">
          <AnnounceDialog courseId={courseId} />
        </div>
      )}
      <CourseReports courseId={courseId} />
    </div>
  );
}
