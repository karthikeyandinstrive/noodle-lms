"use client";

import { PageHeader } from "@/components/common";
import { NotificationCenter } from "@/features/notifications/notification-center";

export default function NotificationsPage() {
  return (
    <div>
      <PageHeader title="Notifications" description="Updates about your courses, grades and achievements." />
      <NotificationCenter />
    </div>
  );
}
