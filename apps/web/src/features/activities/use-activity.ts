"use client";

import { useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { api } from "@/lib/api";
import type { ActivityDetail } from "@/lib/types";

export const activityKey = (id: string) => ["activity", id] as const;

export function useActivity() {
  const { activityId } = useParams<{ activityId: string }>();
  const query = useQuery({ queryKey: activityKey(activityId), queryFn: () => api<ActivityDetail>(`/activities/${activityId}`) });
  return { activityId, ...query };
}
