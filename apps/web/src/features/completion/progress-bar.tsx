"use client";

import { Progress, ProgressLabel, ProgressValue } from "@/components/ui/progress";
import type { MyProgress } from "./types";

/** Course completion progress (accessible progressbar with a visible label). */
export function CourseProgress({ progress }: { progress: MyProgress | undefined }) {
  if (!progress || !progress.enabled || progress.total === 0) return null;
  return (
    <Progress value={progress.percentage} className="gap-1.5">
      <ProgressLabel className="text-xs font-normal text-muted-foreground">
        {progress.completedAt ? "Completed" : `${progress.completed} of ${progress.total} activities`}
      </ProgressLabel>
      <ProgressValue className="text-xs" />
    </Progress>
  );
}
