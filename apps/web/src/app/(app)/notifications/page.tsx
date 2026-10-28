"use client";

import { PageHeader } from "@/components/common";
import { NotificationCenter } from "@/features/notifications/notification-center";
import { useT } from "@/lib/i18n";

export default function NotificationsPage() {
  const t = useT();
  return (
    <div>
      <PageHeader title={t("nav.notifications", "Notifications")} description={t("dashboard.notificationsDescription", "Updates about your courses, grades and achievements.")} />
      <NotificationCenter />
    </div>
  );
}
