/**
 * Minimal RFC 5545 (iCalendar) writer for the calendar feed. Pure — see ics.test.ts.
 */

export type IcsEvent = {
  uid: string;
  name: string;
  description?: string | null;
  startsAt: Date;
  durationMinutes: number;
  url?: string | null;
  categories?: string[];
};

/** Escapes TEXT values (RFC 5545 §3.3.11). */
export function escapeText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Folds content lines longer than 75 octets (RFC 5545 §3.1), never splitting a UTF-8 character. */
export function foldLine(line: string): string {
  const out: string[] = [];
  let current = "";
  let bytes = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch, "utf8");
    const limit = out.length === 0 ? 75 : 74; // continuation lines start with a space
    if (bytes + size > limit) {
      out.push(current);
      current = "";
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out.join("\r\n ");
}

/** UTC timestamp in iCalendar basic format: 20260131T235900Z */
export function icsDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** Strips HTML from stored descriptions for plain-text clients. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function buildIcs(events: IcsEvent[], opts: { calendarName: string; now?: Date }): string {
  const stamp = icsDate(opts.now ?? new Date());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//LMS//Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(opts.calendarName)}`,
  ];
  for (const e of events) {
    const end = new Date(e.startsAt.getTime() + Math.max(0, e.durationMinutes) * 60_000);
    lines.push(
      "BEGIN:VEVENT",
      `UID:${e.uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsDate(e.startsAt)}`,
      `DTEND:${icsDate(end)}`,
      `SUMMARY:${escapeText(e.name)}`,
    );
    if (e.description) lines.push(`DESCRIPTION:${escapeText(htmlToText(e.description))}`);
    if (e.url) lines.push(`URL:${e.url}`);
    if (e.categories?.length) lines.push(`CATEGORIES:${e.categories.map(escapeText).join(",")}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
