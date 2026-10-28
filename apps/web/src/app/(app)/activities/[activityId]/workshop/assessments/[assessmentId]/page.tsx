"use client";

import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { PageHeader, QueryState } from "@/components/common";
import { useActivity } from "@/features/activities/use-activity";
import { useWorkshop } from "@/features/workshop/api";
import { AssessmentPanel } from "@/features/workshop/assessment-form";
import { useT } from "@/lib/i18n";

export default function WorkshopAssessmentPage() {
  const { activityId, assessmentId } = useParams<{ activityId: string; assessmentId: string }>();
  const activity = useActivity();
  const workshop = useWorkshop(activityId);
  const a = activity.data;
  const t = useT();

  return (
    <QueryState query={activity}>
      {a && (
        <div className="space-y-6">
          <Link href={`/activities/${a.id}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ChevronLeft aria-hidden className="size-4" /> {a.name}
          </Link>
          <PageHeader
            title={t("activity.workshop.assessTitle", "Assess a submission")}
            description={t("activity.workshop.assessHint", "The author's identity is hidden while you assess.")}
          />
          <AssessmentPanel activityId={activityId} assessmentId={assessmentId} instructions={workshop.data?.assessmentInstructions} />
        </div>
      )}
    </QueryState>
  );
}
