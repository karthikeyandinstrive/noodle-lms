"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { QueryState } from "@/components/common";
import { useCourse } from "@/features/courses/use-course";
import { cn } from "@/lib/utils";

export default function CourseLayout({ children }: { children: React.ReactNode }) {
  const course = useCourse();
  const pathname = usePathname();
  const base = `/courses/${course.courseId}`;

  const tabs = [
    { href: base, label: "Course", show: true },
    { href: `${base}/participants`, label: "Participants", show: course.can("course:view_participants") },
    { href: `${base}/groups`, label: "Groups", show: course.can("course:manage_groups") },
    { href: `${base}/grades`, label: "Grades", show: course.can("grades:view_all") || course.can("grades:view_own") },
    { href: `${base}/completion`, label: "Completion", show: course.can("report:view_course") },
    { href: `${base}/reports`, label: "Reports", show: course.can("report:view_course") },
    { href: `${base}/question-bank`, label: "Question bank", show: course.can("question:manage") },
    { href: `${base}/badges`, label: "Badges", show: course.can("course:view") },
    { href: `${base}/settings`, label: "Settings", show: course.can("course:update") },
  ].filter((t) => t.show);

  return (
    <QueryState query={course}>
      {course.data && (
        <div>
          <div className="mb-4">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">{course.data.course.fullname}</h1>
              {!course.data.course.visible && <Badge variant="outline">Hidden</Badge>}
            </div>
            <p className="text-sm text-muted-foreground">{course.data.course.shortname}</p>
          </div>
          {course.data.capabilities["course:view"] && tabs.length > 1 && (
            <nav className="mb-6 flex gap-1 overflow-x-auto border-b" aria-label="Course sections">
              {tabs.map((t) => {
                const active = t.href === base ? pathname === base : pathname.startsWith(t.href);
                return (
                  <Link
                    key={t.href}
                    href={t.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "-mb-px border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors",
                      active ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {t.label}
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
