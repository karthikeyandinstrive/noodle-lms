"use client";

import { useQuery } from "@tanstack/react-query";
import { EmptyState, formatDate, QueryState } from "@/components/common";
import { Card, CardContent } from "@/components/ui/card";
import { api } from "@/lib/api";
import { StatusBadge } from "../certificate/shared";
import { BadgeImage } from "./badge-image";
import type { CourseBadge } from "./types";

/** Learner view: the course's badges and which ones I have earned. */
export function CourseBadges({ courseId }: { courseId: string }) {
  const q = useQuery({ queryKey: ["badges", "course", courseId], queryFn: () => api<CourseBadge[]>(`/badges/courses/${courseId}`) });
  return (
    <QueryState query={q}>
      {q.data && !q.data.length && <EmptyState title="No badges in this course" />}
      {q.data && q.data.length > 0 && (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {q.data.map((b) => (
            <li key={b.id}>
              <Card className="h-full">
                <CardContent className="flex items-start gap-3">
                  <BadgeImage badgeId={b.id} hasImage={!!b.imageFileId} muted={!b.earned || b.earned.status !== "valid"} className="size-14" />
                  <div className="min-w-0 space-y-1">
                    <p className="font-medium">{b.name}</p>
                    <p className="text-sm text-muted-foreground">{b.description}</p>
                    <p className="text-xs text-muted-foreground">{b.criteriaText}</p>
                    {b.earned ? (
                      <p className="flex flex-wrap items-center gap-2 text-xs">
                        <StatusBadge status={b.earned.status} /> Earned {formatDate(b.earned.issuedAt, false)}
                      </p>
                    ) : (
                      <p className="text-xs font-medium text-muted-foreground">Not earned yet</p>
                    )}
                  </div>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </QueryState>
  );
}
