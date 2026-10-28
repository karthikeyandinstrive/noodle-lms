"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { CalendarPlus, ChevronLeft, ChevronRight, Rss } from "lucide-react";
import { useMemo, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { EmptyState, QueryState } from "@/components/common";
import { api } from "@/lib/api";
import { useLocale, useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { EventDetailsDialog, EventFormDialog } from "./event-dialogs";
import { TYPE_STYLES, calendarKey, typeLabel, type CalendarItem } from "./types";
import { addDays, addMonths, dayKey, formatTime, monthGrid, sameDay, startOfMonth, weekdayNames } from "./utils";

function EventChip({ event, onOpen }: { event: CalendarItem; onOpen: (e: CalendarItem) => void }) {
  const t = useT();
  const locale = useLocale();
  const start = new Date(event.startsAt);
  return (
    <button
      type="button"
      onClick={() => onOpen(event)}
      className={cn("block w-full truncate rounded px-1 py-0.5 text-left text-[11px] leading-tight focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none", TYPE_STYLES[event.type])}
      title={`${formatTime(start, locale)} ${event.name}`}
    >
      <span className="sr-only">{typeLabel(t, event.type)}: </span>
      {event.durationMinutes > 0 || start.getHours() || start.getMinutes() ? `${formatTime(start, locale)} ` : ""}
      {event.name}
    </button>
  );
}

function MonthGrid({ month, byDay, onOpen, onAdd }: { month: Date; byDay: Map<string, CalendarItem[]>; onOpen: (e: CalendarItem) => void; onAdd: (d: Date) => void }) {
  const t = useT();
  const locale = useLocale();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const days = monthGrid(month);
  const names = weekdayNames(locale);
  const today = new Date();
  return (
    <div className="hidden overflow-hidden rounded-lg border md:block">
      <table className="w-full table-fixed border-collapse">
        <caption className="sr-only">{month.toLocaleDateString(locale, { month: "long", year: "numeric" })}</caption>
        <thead>
          <tr className="bg-muted/50">
            {names.map((n) => (
              <th key={n.long} scope="col" className="py-2 text-xs font-medium text-muted-foreground">
                <abbr title={n.long} className="no-underline">
                  {n.short}
                </abbr>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 6 }, (_, w) => (
            <tr key={w}>
              {days.slice(w * 7, w * 7 + 7).map((d) => {
                const key = dayKey(d);
                const events = byDay.get(key) ?? [];
                const inMonth = d.getMonth() === month.getMonth();
                const isToday = sameDay(d, today);
                const fullDate = d.toLocaleDateString(locale, { dateStyle: "full" });
                const showAll = expanded.has(key);
                const visible = showAll ? events : events.slice(0, 3);
                return (
                  <td key={key} className={cn("group h-28 border-t border-l p-1 align-top first:border-l-0", !inMonth && "bg-muted/30 text-muted-foreground")}>
                    <div className="mb-1 flex items-center justify-between">
                      <span
                        className={cn("flex size-6 items-center justify-center rounded-full text-xs", isToday && "bg-primary font-semibold text-primary-foreground")}
                        aria-current={isToday ? "date" : undefined}
                      >
                        <span aria-hidden>{d.getDate()}</span>
                        <span className="sr-only">
                          {isToday ? t("calendar.todayDate", "Today, {date}", { date: fullDate }) : fullDate}
                          {events.length > 0 &&
                            ` (${events.length === 1 ? t("calendar.eventCount.one", "1 event") : t("calendar.eventCount.other", "{count} events", { count: events.length })})`}
                        </span>
                      </span>
                      <button
                        type="button"
                        className="rounded px-1 text-xs text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-muted focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                        aria-label={t("calendar.addEventOn", "Add event on {date}", { date: fullDate })}
                        onClick={() => onAdd(d)}
                      >
                        <span aria-hidden>+</span>
                      </button>
                    </div>
                    <div className="space-y-0.5">
                      {visible.map((e) => (
                        <EventChip key={e.id} event={e} onOpen={onOpen} />
                      ))}
                      {events.length > 3 && (
                        <button
                          type="button"
                          className="rounded px-1 text-[11px] text-muted-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                          aria-expanded={showAll}
                          onClick={() =>
                            setExpanded((prev) => {
                              const next = new Set(prev);
                              if (next.has(key)) next.delete(key);
                              else next.add(key);
                              return next;
                            })
                          }
                        >
                          {showAll ? t("calendar.showFewer", "Show fewer") : t("calendar.moreEvents", "+{count} more", { count: events.length - 3 })}
                        </button>
                      )}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Agenda list: the only view on small screens, and an accessible summary below the grid. */
export function Agenda({ events, onOpen, className }: { events: CalendarItem[]; onOpen: (e: CalendarItem) => void; className?: string }) {
  const t = useT();
  const locale = useLocale();
  const groups = useMemo(() => {
    const map = new Map<string, { date: Date; events: CalendarItem[] }>();
    for (const e of events) {
      const d = new Date(e.startsAt);
      const key = dayKey(d);
      if (!map.has(key)) map.set(key, { date: d, events: [] });
      map.get(key)!.events.push(e);
    }
    return [...map.values()];
  }, [events]);
  if (!groups.length)
    return (
      <EmptyState
        title={t("calendar.empty", "Nothing scheduled")}
        description={t("calendar.emptyHint", "Events and deadlines for this period will appear here.")}
      />
    );
  return (
    <ol className={cn("space-y-4", className)}>
      {groups.map((g) => (
        <li key={dayKey(g.date)}>
          <h3 className="mb-1.5 text-sm font-medium">{g.date.toLocaleDateString(locale, { weekday: "long", month: "long", day: "numeric" })}</h3>
          <ul className="divide-y rounded-lg border">
            {g.events.map((e) => (
              <li key={e.id}>
                <button type="button" className="flex w-full items-start gap-3 p-3 text-left hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" onClick={() => onOpen(e)}>
                  <span className="w-16 shrink-0 text-xs text-muted-foreground tabular-nums">{formatTime(new Date(e.startsAt), locale)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{e.name}</span>
                    <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      <span className={cn("rounded px-1", TYPE_STYLES[e.type])}>{typeLabel(t, e.type)}</span>
                      {e.courseName && <span className="truncate">{e.courseName}</span>}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}

export function CalendarView() {
  const t = useT();
  const locale = useLocale();
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const [details, setDetails] = useState<CalendarItem | null>(null);
  const [form, setForm] = useState<{ date?: Date; event?: CalendarItem } | null>(null);
  const days = monthGrid(month);
  const from = days[0]!;
  const to = addDays(days[41]!, 1);
  const query = useQuery({
    queryKey: [...calendarKey, "events", from.toISOString(), to.toISOString()],
    queryFn: () => api<CalendarItem[]>("/calendar/events", { query: { from: from.toISOString(), to: to.toISOString() } }),
    placeholderData: keepPreviousData,
  });
  const byDay = useMemo(() => {
    const map = new Map<string, CalendarItem[]>();
    for (const e of query.data ?? []) {
      const key = dayKey(new Date(e.startsAt));
      map.set(key, [...(map.get(key) ?? []), e]);
    }
    return map;
  }, [query.data]);
  const monthEvents = (query.data ?? []).filter((e) => {
    const d = new Date(e.startsAt);
    return d.getMonth() === month.getMonth() && d.getFullYear() === month.getFullYear();
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon-sm" aria-label={t("calendar.prevMonth", "Previous month")} onClick={() => setMonth(addMonths(month, -1))}>
            <ChevronLeft aria-hidden />
          </Button>
          <Button variant="outline" size="icon-sm" aria-label={t("calendar.nextMonth", "Next month")} onClick={() => setMonth(addMonths(month, 1))}>
            <ChevronRight aria-hidden />
          </Button>
          <h2 className="text-lg font-semibold" aria-live="polite">
            {month.toLocaleDateString(locale, { month: "long", year: "numeric" })}
          </h2>
          <Button variant="ghost" size="sm" onClick={() => setMonth(startOfMonth(new Date()))}>
            {t("calendar.today", "Today")}
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          <a href="/api/v1/calendar/export.ics" download="calendar.ics" className={buttonVariants({ variant: "outline", size: "sm" })}>
            <Rss aria-hidden /> {t("calendar.exportIcal", "Export iCal")}
          </a>
          <Button size="sm" onClick={() => setForm({ date: new Date() })}>
            <CalendarPlus aria-hidden /> {t("calendar.newEvent", "New event")}
          </Button>
        </div>
      </div>
      <QueryState query={query}>
        <MonthGrid month={month} byDay={byDay} onOpen={setDetails} onAdd={(date) => setForm({ date })} />
        <div className="md:hidden">
          <Agenda events={monthEvents} onOpen={setDetails} />
        </div>
      </QueryState>
      <EventDetailsDialog
        event={details}
        onClose={() => setDetails(null)}
        onEdit={(event) => {
          setDetails(null);
          setForm({ event });
        }}
      />
      {form && <EventFormDialog open onClose={() => setForm(null)} initialDate={form.date} event={form.event} />}
    </div>
  );
}
