"use client";

import { PageHeader } from "@/components/common";
import { CalendarView } from "@/features/calendar/calendar-view";
import { useT } from "@/lib/i18n";

export default function CalendarPage() {
  const t = useT();
  return (
    <div>
      <PageHeader title={t("nav.calendar", "Calendar")} description={t("dashboard.calendarDescription", "Site and course events, your personal events and activity deadlines.")} />
      <CalendarView />
    </div>
  );
}
