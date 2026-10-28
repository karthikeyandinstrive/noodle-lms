"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { CalendarPlus, ChevronLeft, ChevronRight, Rss } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState, QueryState } from "@/components/common";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { EventDetailsDialog, EventFormDialog } from "./event-dialogs";
import { TYPE_LABELS, TYPE_STYLES, calendarKey, type CalendarItem } from "./types";
import { addDays, addMonths, dayKey, formatTime, monthGrid, sameDay, startOfMonth, weekdayNames } from "./utils";

function EventChip({ event, onOpen }: { event: CalendarItem; onOpen: (e: CalendarItem) => void }) {
  const start = new Date(event.startsAt);
  return (
    <button
      type="button"
      onClick={() => onOpen(event)}
      className={cn("block w-full truncate rounded px-1 py-0.5 text-left text-[11px] leading-tight focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none", TYPE_STYLES[event.type])}
      title={`${formatTime(start)} ${event.name}`}
    >
      <span className="sr-only">{TYPE_LABELS[event.type]}: </span>
      {event.durationMinutes > 0 || start.getHours() || start.getMinutes() ? `${formatTime(start)} ` : ""}
      {event.name}
    </button>
  );
}

function MonthGrid({ month, byDay, onOpen, onAdd }: { month: Date; byDay: Map<string, CalendarItem[]>; onOpen: (e: CalendarItem) => void; onAdd: (d: Date) => void }) {
  const days = monthGrid(month);
  const names = weekdayNames();
  const today = new Date();
  return (
    <div className="hidden overflow-hidden rounded-lg border md:block">
      <table className="w-full table-fixed border-collapse">
        <caption className="sr-only">{month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</caption>
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
                const events = byDay.get(dayKey(d)) ?? [];
                const inMonth = d.getMonth() === month.getMonth();
                const isToday = sameDay(d, today);
                return (
                  <td key={dayKey(d)} className={cn("group h-28 border-t border-l p-1 align-top first:border-l-0", !inMonth && "bg-muted/30 text-muted-foreground")}>
                    <div className="mb-1 flex items-center justify-between">
                      <span
                        className={cn("flex size-6 items-center justify-center rounded-full text-xs", isToday && "bg-primary font-semibold text-primary-foreground")}
                        aria-current={isToday ? "date" : undefined}
                      >
                        {d.getDate()}
                      </span>
                      <button
                        type="button"
                        className="rounded px-1 text-xs text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-muted focus-visible:opacity-100"
                        aria-label={`Add event on ${d.toLocaleDateString(undefined, { dateStyle: "full" })}`}
                        onClick={() => onAdd(d)}
                      >
                        +
                      </button>
                    </div>
                    <div className="space-y-0.5">
                      {events.slice(0, 3).map((e) => (
                        <EventChip key={e.id} event={e} onOpen={onOpen} />
                      ))}
                      {events.length > 3 && <p className="px-1 text-[11px] text-muted-foreground">+{events.length - 3} more</p>}
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
  if (!groups.length) return <EmptyState title="Nothing scheduled" description="Events and deadlines for this period will appear here." />;
  return (
    <ol className={cn("space-y-4", className)}>
      {groups.map((g) => (
        <li key={dayKey(g.date)}>
          <h3 className="mb-1.5 text-sm font-medium">{g.date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</h3>
          <ul className="divide-y rounded-lg border">
            {g.events.map((e) => (
              <li key={e.id}>
                <button type="button" className="flex w-full items-start gap-3 p-3 text-left hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" onClick={() => onOpen(e)}>
                  <span className="w-16 shrink-0 text-xs text-muted-foreground tabular-nums">{formatTime(new Date(e.startsAt))}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{e.name}</span>
                    <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      <span className={cn("rounded px-1", TYPE_STYLES[e.type])}>{TYPE_LABELS[e.type]}</span>
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
          <Button variant="outline" size="icon-sm" aria-label="Previous month" onClick={() => setMonth(addMonths(month, -1))}>
            <ChevronLeft />
          </Button>
          <Button variant="outline" size="icon-sm" aria-label="Next month" onClick={() => setMonth(addMonths(month, 1))}>
            <ChevronRight />
          </Button>
          <h2 className="text-lg font-semibold" aria-live="polite">
            {month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
          </h2>
          <Button variant="ghost" size="sm" onClick={() => setMonth(startOfMonth(new Date()))}>
            Today
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" render={<a href="/api/v1/calendar/export.ics" download="calendar.ics" />}>
            <Rss /> Export iCal
          </Button>
          <Button size="sm" onClick={() => setForm({ date: new Date() })}>
            <CalendarPlus /> New event
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
