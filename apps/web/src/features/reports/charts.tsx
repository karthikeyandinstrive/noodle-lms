"use client";

import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** Small KPI tile. */
export function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <Card className="gap-1 py-4">
      <CardContent className="px-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-2xl font-semibold tabular-nums">{value}</p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

/** Horizontal bar for table cells; the number is rendered next to it, so the bar itself is decorative. */
export function InlineBar({ value, max, className }: { value: number; max: number; className?: string }) {
  const pct = max > 0 ? Math.max(value > 0 ? 2 : 0, Math.round((value / max) * 100)) : 0;
  return (
    <div className={cn("h-2 w-full min-w-16 rounded-full bg-muted", className)} aria-hidden>
      <div className="h-2 rounded-full bg-primary" style={{ width: `${pct}%` }} />
    </div>
  );
}

/**
 * Daily column chart made of plain CSS bars (no chart library). The visual is hidden from
 * assistive technology; an equivalent data table is provided for screen readers.
 */
export function DailyBars({ title, data, unit }: { title: string; data: { date: string; value: number }[]; unit: string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const total = data.reduce((s, d) => s + d.value, 0);
  const fmt = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  return (
    <figure className="space-y-2">
      <figcaption className="flex items-baseline justify-between gap-2 text-sm">
        <span className="font-medium">{title}</span>
        <span className="text-xs text-muted-foreground">peak {max === 1 && total === 0 ? 0 : max} {unit}/day</span>
      </figcaption>
      <div className="flex h-40 items-end gap-[2px] border-b border-l px-1 pt-2" aria-hidden>
        {data.map((d) => (
          <div key={d.date} className="group relative flex h-full flex-1 items-end" title={`${fmt(d.date)}: ${d.value} ${unit}`}>
            <div className="w-full rounded-t-sm bg-primary/80 transition-colors group-hover:bg-primary" style={{ height: `${(d.value / max) * 100}%`, minHeight: d.value ? 2 : 0 }} />
          </div>
        ))}
      </div>
      <div className="flex justify-between text-[11px] text-muted-foreground" aria-hidden>
        <span>{data[0] && fmt(data[0].date)}</span>
        <span>{data.at(-1) && fmt(data.at(-1)!.date)}</span>
      </div>
      <table className="sr-only">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">{unit}</th>
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.date}>
              <th scope="row">{fmt(d.date)}</th>
              <td>{d.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

export function Pager({ page, pages, onPage }: { page: number; pages: number; onPage: (p: number) => void }) {
  if (pages <= 1) return null;
  return (
    <nav className="flex items-center justify-center gap-2" aria-label="Pagination">
      <button type="button" className="rounded-md border px-2.5 py-1 text-sm disabled:opacity-50" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        Previous
      </button>
      <span className="text-sm text-muted-foreground">
        Page {page} of {pages}
      </span>
      <button type="button" className="rounded-md border px-2.5 py-1 text-sm disabled:opacity-50" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        Next
      </button>
    </nav>
  );
}
