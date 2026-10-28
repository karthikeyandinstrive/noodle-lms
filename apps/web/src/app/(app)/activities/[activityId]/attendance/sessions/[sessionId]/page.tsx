"use client";

import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { QueryState } from "@/components/common";
import { useActivity } from "@/features/activities/use-activity";
import { TakeAttendance } from "@/features/attendance/take-attendance";
import { useT } from "@/lib/i18n";

export default function TakeAttendancePage() {
  const { activityId, sessionId } = useParams<{ activityId: string; sessionId: string }>();
  const activity = useActivity();
  const a = activity.data;
  const t = useT();

  return (
    <QueryState query={activity}>
      {a && (
        <div className="space-y-6">
          <Link href={`/activities/${a.id}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ChevronLeft aria-hidden className="size-4" /> {a.name}
          </Link>
          {a.capabilities["attendance:take"] ? (
            <TakeAttendance activityId={activityId} sessionId={sessionId} />
          ) : (
            <p className="text-sm text-muted-foreground">{t("activity.noPermissionAttendance", "You don't have permission to take attendance.")}</p>
          )}
        </div>
      )}
    </QueryState>
  );
}
