"use client";

import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/common";
import { CourseForm } from "@/features/courses/course-form";
import { api } from "@/lib/api";
import type { Course } from "@/lib/types";
import { useT } from "@/lib/i18n";

export default function NewCoursePage() {
  const router = useRouter();
  const t = useT();
  return (
    <>
      <PageHeader title={t("course.new", "New course")} />
      <CourseForm
        submitLabel={t("course.create", "Create course")}
        onSubmit={async (values) => {
          const course = await api<Course>("/courses", { body: values });
          router.push(`/courses/${course.id}`);
        }}
      />
    </>
  );
}
