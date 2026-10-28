"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { ActivityForm } from "@/features/activities/activity-form";
import { courseKey, useCourse } from "@/features/courses/use-course";
import { api } from "@/lib/api";
import type { ActivityDetail, ActivityType } from "@/lib/types";
import { useT } from "@/lib/i18n";

function NewActivity() {
  const { courseId, data } = useCourse();
  const router = useRouter();
  const qc = useQueryClient();
  const params = useSearchParams();
  const t = useT();

  if (!data) return null;
  return (
    <div>
      <h2 className="mb-4 text-lg font-semibold">{t("course.addAnActivity", "Add an activity")}</h2>
      <ActivityForm
        courseId={courseId}
        sections={data.sections}
        initialSectionId={params.get("sectionId") ?? undefined}
        initialType={(params.get("type") as ActivityType | null) ?? undefined}
        onSubmit={async (values) => {
          const created = await api<ActivityDetail>(`/courses/${courseId}/activities`, { body: values });
          await qc.invalidateQueries({ queryKey: courseKey(courseId) });
          router.push(`/activities/${created.id}`);
        }}
      />
    </div>
  );
}

export default function NewActivityPage() {
  return (
    <Suspense>
      <NewActivity />
    </Suspense>
  );
}
