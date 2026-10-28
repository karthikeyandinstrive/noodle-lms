"use client";

import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { QueryState } from "@/components/common";
import { useActivity } from "@/features/activities/use-activity";
import { DiscussionThread } from "@/features/forum/discussion-thread";
import { useT } from "@/lib/i18n";

export default function ForumDiscussionPage() {
  const { discussionId } = useParams<{ activityId: string; discussionId: string }>();
  const activity = useActivity();
  const a = activity.data;
  const t = useT();

  return (
    <QueryState query={activity}>
      {a && (
        <div className="space-y-6">
          <nav aria-label={t("activity.breadcrumb", "Breadcrumb")} className="flex flex-wrap items-center gap-x-1 text-sm text-muted-foreground">
            <Link href={`/courses/${a.course.id}`} className="hover:text-foreground">
              {a.course.fullname}
            </Link>
            <span aria-hidden>/</span>
            <Link href={`/activities/${a.id}`} className="inline-flex items-center gap-1 hover:text-foreground">
              <ChevronLeft aria-hidden className="size-4" /> {a.name}
            </Link>
          </nav>
          {a.type === "forum" ? (
            <DiscussionThread activityId={a.id} discussionId={discussionId} />
          ) : (
            <p className="text-sm text-muted-foreground">{t("activity.notAForum", "This activity is not a forum.")}</p>
          )}
        </div>
      )}
    </QueryState>
  );
}
