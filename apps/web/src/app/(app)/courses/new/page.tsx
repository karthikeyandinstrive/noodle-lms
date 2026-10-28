"use client";

import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/common";
import { CourseForm } from "@/features/courses/course-form";
import { api } from "@/lib/api";
import type { Course } from "@/lib/types";

export default function NewCoursePage() {
  const router = useRouter();
  return (
    <>
      <PageHeader title="New course" />
      <CourseForm
        submitLabel="Create course"
        onSubmit={async (values) => {
          const course = await api<Course>("/courses", { body: values });
          router.push(`/courses/${course.id}`);
        }}
      />
    </>
  );
}
