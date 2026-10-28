"use client";

import { Progress, ProgressLabel, ProgressValue } from "@/components/ui/progress";
import { useT } from "@/lib/i18n";
import type { MyProgress } from "./types";

/** Course completion progress (accessible progressbar with a visible label). */
export function CourseProgress({ progress }: { progress: MyProgress | undefined }) {
  const t = useT();
  if (!progress || !progress.enabled || progress.total === 0) return null;
  return (
    <Progress value={progress.percentage} className="gap-1.5">
      <ProgressLabel className="text-xs font-normal text-muted-foreground">
        {progress.completedAt
          ? t("completion.state.complete", "Completed")
          : t("completion.progressOf", "{completed} of {total} activities", { completed: progress.completed, total: progress.total })}
      </ProgressLabel>
      <ProgressValue className="text-xs" />
    </Progress>
  );
}
