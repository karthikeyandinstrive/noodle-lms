"use client";

import { Suspense } from "react";
import { RestorePage } from "@/features/backup/restore-page";

export default function Page() {
  return (
    <Suspense>
      <RestorePage />
    </Suspense>
  );
}
