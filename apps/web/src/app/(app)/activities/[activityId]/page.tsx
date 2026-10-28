"use client";

import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ChevronLeft, Pencil } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { HtmlContent, QueryState, formatDate } from "@/components/common";
import { activityRegistry } from "@/features/activities/registry";
import { activityKey, useActivity } from "@/features/activities/use-activity";

export default function ActivityPage() {
  const query = useActivity();
  const qc = useQueryClient();
  const a = query.data;

  return (
    <QueryState query={query}>
      {a && (
        <div className="space-y-6">
          <div>
            <Link href={`/courses/${a.course.id}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
              <ChevronLeft className="size-4" /> {a.course.fullname}
            </Link>
            <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                {(() => {
                  const Icon = activityRegistry[a.type].icon;
                  return <Icon className="size-6 text-primary" />;
                })()}
                <h1 className="text-2xl font-semibold tracking-tight">{a.name}</h1>
                {!a.visible && <Badge variant="outline">Hidden</Badge>}
                {(a.completion === "complete" || a.completion === "complete_pass") && (
                  <Badge className="gap-1">
                    <CheckCircle2 className="size-3" /> Done
                  </Badge>
                )}
              </div>
              {a.capabilities["activity:update"] && (
                <Button variant="outline" size="sm" render={<Link href={`/activities/${a.id}/edit`} />}>
                  <Pencil /> Edit settings
                </Button>
              )}
            </div>
            {(a.availableFrom || a.availableUntil) && (
              <p className="mt-1 text-sm text-muted-foreground">
                {a.availableFrom && <>Opens {formatDate(a.availableFrom)} </>}
                {a.availableUntil && <>· Closes {formatDate(a.availableUntil)}</>}
              </p>
            )}
          </div>
          <HtmlContent html={a.description} />
          {(() => {
            const View = activityRegistry[a.type].View;
            return <View activity={a} refresh={() => void qc.invalidateQueries({ queryKey: activityKey(a.id) })} />;
          })()}
        </div>
      )}
    </QueryState>
  );
}
