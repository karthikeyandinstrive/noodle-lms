"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState, PageHeader } from "@/components/common";
import { useCourse } from "@/features/courses/use-course";
import { GradeSetup } from "@/features/gradebook/grade-setup";
import { useT } from "@/lib/i18n";

export default function GradebookSetupPage() {
  const { courseId, data, can } = useCourse();
  const t = useT();
  if (!data) return null;
  if (!can("grades:edit")) return (
      <EmptyState
        title={t("course.gradebookSetupUnavailable", "Gradebook setup is not available")}
        description={t("course.noPermissionGradebook", "You don't have permission to edit this gradebook.")}
      />
    );
  return (
    <div>
      <PageHeader
        title={t("course.gradebookSetup", "Gradebook setup")}
        description={t("course.gradebookSetupDescription", "Organise grade items into categories, choose how they are aggregated and weighted, and add manual items.")}
        actions={
          <Link href={`/courses/${courseId}/grades`} className={buttonVariants({ variant: "outline", size: "sm" })}>
            <ArrowLeft aria-hidden /> {t("course.graderReport", "Grader report")}
          </Link>
        }
      />
      <GradeSetup courseId={courseId} />
    </div>
  );
}
