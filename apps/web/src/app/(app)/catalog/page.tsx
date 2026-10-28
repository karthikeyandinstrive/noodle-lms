"use client";

import { PageHeader } from "@/components/common";
import { CourseList } from "@/features/courses/course-list";

export default function CatalogPage() {
  return (
    <>
      <PageHeader title="Course catalog" description="Browse courses and enrol." />
      <CourseList mine={false} />
    </>
  );
}
