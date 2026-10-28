"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { PageHeader, QueryState } from "@/components/common";
import { ActivityForm } from "@/features/activities/activity-form";
import { activityKey, useActivity } from "@/features/activities/use-activity";
import { courseKey } from "@/features/courses/use-course";
import { api } from "@/lib/api";
import type { CourseOverview } from "@/lib/types";

export default function EditActivityPage() {
  const activity = useActivity();
  const router = useRouter();
  const qc = useQueryClient();
  const courseId = activity.data?.courseId;
  const course = useQuery({
    queryKey: courseKey(courseId ?? ""),
    queryFn: () => api<CourseOverview>(`/courses/${courseId}`),
    enabled: !!courseId,
  });

  return (
    <QueryState query={activity}>
      {activity.data && course.data && (
        <>
          <PageHeader title={`Edit ${activity.data.name}`} />
          <ActivityForm
            courseId={activity.data.courseId}
            sections={course.data.sections}
            initial={activity.data}
            onSubmit={async (values) => {
              const { type, ...patch } = values;
              void type; // the type of an existing activity can't change
              await api(`/activities/${activity.data!.id}`, { method: "PATCH", body: patch });
              await qc.invalidateQueries({ queryKey: activityKey(activity.data!.id) });
              await qc.invalidateQueries({ queryKey: courseKey(activity.data!.courseId) });
              router.push(`/activities/${activity.data!.id}`);
            }}
          />
        </>
      )}
    </QueryState>
  );
}
