"use client";

import { Plus } from "lucide-react";
import Link from "next/link";
import { PageHeader } from "@/components/common";
import { buttonVariants } from "@/components/ui/button";
import { CourseList } from "@/features/courses/course-list";
import { useSession } from "@/lib/session";
import { useT } from "@/lib/i18n";

export default function MyCoursesPage() {
  const { can } = useSession();
  const t = useT();
  return (
    <>
      <PageHeader
        title={t("nav.myCourses", "My courses")}
        actions={
          can("course:create") && (
            <Link href="/courses/new" className={buttonVariants()}>
              <Plus aria-hidden /> {t("course.new", "New course")}
            </Link>
          )
        }
      />
      <CourseList mine />
    </>
  );
}
