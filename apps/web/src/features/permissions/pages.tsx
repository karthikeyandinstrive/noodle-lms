"use client";

import { ChevronLeft, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { PageHeader, QueryState } from "@/components/common";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { useActivity } from "@/features/activities/use-activity";
import { useCourse } from "@/features/courses/use-course";
import { useT } from "@/lib/i18n";
import type { CourseOverview } from "@/lib/types";
import { useMyCapabilities } from "./api";
import { ContextPermissions } from "./context-permissions";

function NotAllowed() {
  const t = useT();
  return (
    <Alert>
      <ShieldAlert />
      <AlertTitle>{t("permissions.notAvailable", "Not available")}</AlertTitle>
      <AlertDescription>{t("permissions.notAllowed", "You don't have permission to manage roles here.")}</AlertDescription>
    </Alert>
  );
}

/** /courses/[courseId]/permissions — rendered inside the course layout (title and tabs come from there). */
export function CoursePermissionsPage() {
  const t = useT();
  const course = useCourse();
  // `contextId` is only returned to users who hold role:assign in the course.
  const contextId = (course.data as (CourseOverview & { contextId?: string | null }) | undefined)?.contextId ?? null;
  return (
    <QueryState query={course}>
      {course.data &&
        (!course.can("role:assign") ? (
          <NotAllowed />
        ) : !contextId ? (
          <Alert>
            <ShieldAlert />
            <AlertTitle>{t("permissions.contextMissingTitle", "Permissions can't be loaded")}</AlertTitle>
            <AlertDescription>{t("permissions.contextMissing", "The course context is not available. Reload the page or update the server.")}</AlertDescription>
          </Alert>
        ) : (
          <>
            <div className="mb-4">
              <h2 className="text-lg font-semibold">{t("permissions.courseTitle", "Course permissions")}</h2>
              <p className="text-sm text-muted-foreground">
                {t("permissions.courseHelp", "Overrides set here apply to this course and every activity in it, unless an activity overrides them again.")}
              </p>
            </div>
            <ContextPermissions contextId={contextId} level="course" courseId={course.courseId} />
          </>
        ))}
    </QueryState>
  );
}

/** /activities/[activityId]/permissions */
export function ActivityPermissionsPage() {
  const t = useT();
  const activity = useActivity();
  const a = activity.data;
  const mine = useMyCapabilities(a?.contextId, ["role:assign"]);
  return (
    <QueryState query={activity}>
      {a && (
        <div>
          <Link href={`/activities/${a.id}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ChevronLeft className="size-4" /> {a.name}
          </Link>
          <PageHeader
            className="mt-2"
            title={t("permissions.activityTitle", "Permissions: {name}", { name: a.name })}
            description={t("permissions.activityHelp", "Overrides set here apply to this activity only. Course: {course}", { course: a.course.fullname })}
          />
          {mine.isPending ? (
            <Skeleton className="h-32 w-full" />
          ) : mine.data?.["role:assign"] ? (
            <ContextPermissions contextId={a.contextId} level="activity" courseId={a.courseId} preferredPrefix={a.type} />
          ) : (
            <NotAllowed />
          )}
        </div>
      )}
    </QueryState>
  );
}
