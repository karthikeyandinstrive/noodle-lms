"use client";

import { PageHeader } from "@/components/common";
import { CalendarView } from "@/features/calendar/calendar-view";

export default function CalendarPage() {
  return (
    <div>
      <PageHeader title="Calendar" description="Site and course events, your personal events and activity deadlines." />
      <CalendarView />
    </div>
  );
}
