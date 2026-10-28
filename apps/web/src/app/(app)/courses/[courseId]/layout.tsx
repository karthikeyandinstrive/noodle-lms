"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { QueryState } from "@/components/common";
import { useCourse } from "@/features/courses/use-course";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export default function CourseLayout({ children }: { children: React.ReactNode }) {
  const course = useCourse();
  const pathname = usePathname();
  const t = useT();
  const base = `/courses/${course.courseId}`;

  const tabs = [
    { href: base, label: t("course.tab.course", "Course"), show: true },
    { href: `${base}/participants`, label: t("course.tab.participants", "Participants"), show: course.can("course:view_participants") },
    { href: `${base}/groups`, label: t("course.tab.groups", "Groups"), show: course.can("course:manage_groups") },
    { href: `${base}/grades`, label: t("course.tab.grades", "Grades"), show: course.can("grades:view_all") || course.can("grades:view_own") },
    { href: `${base}/completion`, label: t("course.tab.completion", "Completion"), show: course.can("report:view_course") },
    { href: `${base}/reports`, label: t("course.tab.reports", "Reports"), show: course.can("report:view_course") },
    { href: `${base}/question-bank`, label: t("course.tab.questionBank", "Question bank"), show: course.can("question:manage") },
    { href: `${base}/badges`, label: t("course.tab.badges", "Badges"), show: course.can("course:view") },
    { href: `${base}/permissions`, label: t("course.tab.permissions", "Permissions"), show: course.can("role:assign") },
    { href: `${base}/backup`, label: t("course.tab.backup", "Backup"), show: course.can("course:backup") },
    { href: `${base}/settings`, label: t("course.tab.settings", "Settings"), show: course.can("course:update") },
  ].filter((tab) => tab.show);

  return (
    <QueryState query={course}>
      {course.data && (
        <div>
          <div className="mb-4">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">{course.data.course.fullname}</h1>
              {!course.data.course.visible && <Badge variant="outline">{t("common.hidden", "Hidden")}</Badge>}
            </div>
            <p className="text-sm text-muted-foreground">{course.data.course.shortname}</p>
          </div>
          {course.data.capabilities["course:view"] && tabs.length > 1 && (
            <nav className="mb-6 flex gap-1 overflow-x-auto border-b" aria-label={t("course.tabsLabel", "Course sections")}>
              {tabs.map((tab) => {
                const active = tab.href === base ? pathname === base : pathname.startsWith(tab.href);
                return (
                  <Link
                    key={tab.href}
                    href={tab.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "-mb-px rounded-t-md border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      active ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {tab.label}
                  </Link>
                );
              })}
            </nav>
          )}
          {children}
        </div>
      )}
    </QueryState>
  );
}
