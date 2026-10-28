"use client";

import { QueryState } from "@/components/common";
import { useCourse } from "@/features/courses/use-course";
import { CourseLtiTools } from "@/features/lti/admin";

export default function Page() {
  const course = useCourse();
  return (
    <QueryState query={course}>
      <CourseLtiTools courseId={course.courseId} canManage={course.can("lti:manage_course_tools")} />
    </QueryState>
  );
}
