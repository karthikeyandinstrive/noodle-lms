"use client";

import { PageHeader } from "@/components/common";
import { MyGradesOverview } from "@/features/gradebook/my-grades";

export default function MyGradesPage() {
  return (
    <div>
      <PageHeader title="My grades" description="Your course totals. Select a course to see every grade." />
      <MyGradesOverview />
    </div>
  );
}
