import type { Translate } from "@/lib/i18n";

export type CalendarItemType = "site" | "course" | "user" | "due" | "session";

export type CalendarItem = {
  id: string;
  type: CalendarItemType;
  name: string;
  description: string | null;
  startsAt: string;
  durationMinutes: number;
  courseId: string | null;
  courseName: string | null;
  activityId: string | null;
  link: string | null;
  editable: boolean;
};

export type CalendarPermissions = { site: boolean; courses: { id: string; fullname: string }[] };

export const TYPE_LABELS: Record<CalendarItemType, string> = {
  site: "Site event",
  course: "Course event",
  user: "Personal event",
  due: "Deadline",
  session: "Session",
};

/** Translated label for an event type (English fallback from TYPE_LABELS). */
export function typeLabel(t: Translate, type: CalendarItemType) {
  return t(`calendar.type.${type}`, TYPE_LABELS[type]);
}

/** Tailwind classes per event type (dot + chip). */
export const TYPE_STYLES: Record<CalendarItemType, string> = {
  site: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  course: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  user: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  due: "bg-red-500/15 text-red-700 dark:text-red-300",
  session: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
};

export const calendarKey = ["calendar"] as const;
