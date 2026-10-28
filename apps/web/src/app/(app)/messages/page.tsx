"use client";

import { Suspense } from "react";
import { MessagesPage } from "@/features/messaging/messages-page";

export default function Page() {
  return (
    <Suspense>
      <MessagesPage />
    </Suspense>
  );
}
