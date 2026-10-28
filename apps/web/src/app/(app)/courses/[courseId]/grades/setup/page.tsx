"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { EmptyState, PageHeader } from "@/components/common";
import { useCourse } from "@/features/courses/use-course";
import { GradeSetup } from "@/features/gradebook/grade-setup";

export default function GradebookSetupPage() {
  const { courseId, data, can } = useCourse();
  if (!data) return null;
  if (!can("grades:edit")) return <EmptyState title="Gradebook setup is not available" description="You don't have permission to edit this gradebook." />;
  return (
    <div>
      <PageHeader
        title="Gradebook setup"
        description="Organise grade items into categories, choose how they are aggregated and weighted, and add manual items."
        actions={
          <Button variant="outline" size="sm" render={<Link href={`/courses/${courseId}/grades`} />}>
            <ArrowLeft /> Grader report
          </Button>
        }
      />
      <GradeSetup courseId={courseId} />
    </div>
  );
}
