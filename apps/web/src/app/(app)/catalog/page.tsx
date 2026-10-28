"use client";

import { PageHeader } from "@/components/common";
import { CourseList } from "@/features/courses/course-list";
import { useT } from "@/lib/i18n";

export default function CatalogPage() {
  const t = useT();
  return (
    <>
      <PageHeader title={t("nav.catalog", "Course catalog")} description={t("catalog.description", "Browse courses and enrol.")} />
      <CourseList mine={false} />
    </>
  );
}
