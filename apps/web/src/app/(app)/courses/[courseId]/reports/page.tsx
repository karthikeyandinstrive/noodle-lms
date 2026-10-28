"use client";

import { EmptyState } from "@/components/common";
import { useCourse } from "@/features/courses/use-course";
import { AnnounceDialog } from "@/features/notifications/announce-dialog";
import { CourseReports } from "@/features/reports/course-reports";

export default function CourseReportsPage() {
  const { courseId, data, can } = useCourse();
  if (!data) return null;
  if (!can("report:view_course")) return <EmptyState title="Reports are not available" description="You don't have permission to view course reports." />;
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
