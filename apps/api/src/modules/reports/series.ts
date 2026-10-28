/** Pure helpers for report time series (see series.test.ts). */

const DAY = 24 * 60 * 60 * 1000;

/** UTC calendar day "YYYY-MM-DD". */
export const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/** Start (UTC midnight) of the first day of a `days`-long window ending today (inclusive). */
export function windowStart(days: number, now = new Date()): Date {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(today - (days - 1) * DAY);
}

/** Expands sparse {date,value} rows into one entry per day of the window, filling gaps with 0. */
export function fillDays(rows: { date: string; value: number }[], days: number, now = new Date()) {
  const byDay = new Map(rows.map((r) => [r.date, Number(r.value)]));
  const start = windowStart(days, now).getTime();
  return Array.from({ length: days }, (_, i) => {
    const date = dayKey(new Date(start + i * DAY));
    return { date, value: byDay.get(date) ?? 0 };
  });
}
