"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { BadgeManager } from "@/features/badges/badge-manager";
import { CourseBadges } from "@/features/badges/course-badges";
import { useCourse } from "@/features/courses/use-course";
import { useT } from "@/lib/i18n";

export default function CourseBadgesPage() {
  const course = useCourse();
  const t = useT();
  const canManage = course.can("badge:manage");
  const [preview, setPreview] = useState(false);
  if (!course.data) return null;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{t("course.tab.badges", "Badges")}</h2>
        {canManage && (
          <Button variant="ghost" size="sm" aria-pressed={preview} onClick={() => setPreview((p) => !p)}>
            {preview ? t("course.badges.backToManagement", "Back to management") : t("course.badges.viewAsLearner", "View as learner")}
          </Button>
        )}
      </div>
      {canManage && !preview ? (
        <BadgeManager courseId={course.courseId} course={course.data} canAward={course.can("badge:award") || canManage} />
      ) : (
        <CourseBadges courseId={course.courseId} />
      )}
    </div>
  );
}
