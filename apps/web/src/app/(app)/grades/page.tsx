"use client";

import { PageHeader } from "@/components/common";
import { MyGradesOverview } from "@/features/gradebook/my-grades";
import { useT } from "@/lib/i18n";

export default function MyGradesPage() {
  const t = useT();
  return (
    <div>
      <PageHeader title={t("nav.grades", "My grades")} description={t("course.myGradesDescription", "Your course totals. Select a course to see every grade.")} />
      <MyGradesOverview />
    </div>
  );
}
