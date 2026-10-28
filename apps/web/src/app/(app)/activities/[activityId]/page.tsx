"use client";

import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ChevronLeft, Pencil, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { HtmlContent, QueryState } from "@/components/common";
import { activityRegistry } from "@/features/activities/registry";
import { activityKey, useActivity } from "@/features/activities/use-activity";
import { useFormat, useT } from "@/lib/i18n";

export default function ActivityPage() {
  const query = useActivity();
  const qc = useQueryClient();
  const t = useT();
  const fmt = useFormat();
  const a = query.data;

  return (
    <QueryState query={query}>
      {a && (
        <div className="space-y-6">
          <div>
            <Link href={`/courses/${a.course.id}`} className="inline-flex items-center gap-1 rounded-sm text-sm text-muted-foreground hover:text-foreground">
              <ChevronLeft aria-hidden className="size-4" /> {a.course.fullname}
            </Link>
            <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                {(() => {
                  const Icon = activityRegistry[a.type].icon;
                  return <Icon aria-hidden className="size-6 text-primary" />;
                })()}
                <h1 className="text-2xl font-semibold tracking-tight">{a.name}</h1>
                {!a.visible && <Badge variant="outline">{t("common.hidden", "Hidden")}</Badge>}
                {(a.completion === "complete" || a.completion === "complete_pass") && (
                  <Badge className="gap-1">
                    <CheckCircle2 aria-hidden className="size-3" /> {t("completion.done", "Done")}
                  </Badge>
                )}
              </div>
              {a.capabilities["activity:update"] && (
                <div className="flex flex-wrap gap-2">
                  <Link href={`/activities/${a.id}/edit`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                    <Pencil aria-hidden /> {t("activity.editSettings", "Edit settings")}
                  </Link>
                  <Link href={`/activities/${a.id}/permissions`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                    <ShieldCheck aria-hidden /> {t("activity.permissions", "Permissions")}
                  </Link>
                </div>
              )}
            </div>
            {(a.availableFrom || a.availableUntil) && (
              <p className="mt-1 text-sm text-muted-foreground">
                {a.availableFrom && <>{t("activity.opens", "Opens {date}", { date: fmt.date(a.availableFrom) })} </>}
                {a.availableUntil && <>· {t("activity.closes", "Closes {date}", { date: fmt.date(a.availableUntil) })}</>}
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
