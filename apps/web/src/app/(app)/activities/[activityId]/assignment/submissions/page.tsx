"use client";

import { Suspense } from "react";
import { AssignmentGradingPage } from "@/features/assignment/grading-page";

export default function Page() {
  return (
    <Suspense>
      <AssignmentGradingPage />
    </Suspense>
  );
}
