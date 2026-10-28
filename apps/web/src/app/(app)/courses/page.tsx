"use client";

import { Plus } from "lucide-react";
import Link from "next/link";
import { PageHeader } from "@/components/common";
import { Button } from "@/components/ui/button";
import { CourseList } from "@/features/courses/course-list";
import { useSession } from "@/lib/session";

export default function MyCoursesPage() {
  const { can } = useSession();
  return (
    <>
      <PageHeader
        title="My courses"
        actions={
          can("course:create") && (
            <Button render={<Link href="/courses/new" />}>
              <Plus /> New course
            </Button>
          )
        }
      />
      <CourseList mine />
    </>
  );
}
