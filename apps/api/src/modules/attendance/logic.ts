/** Pure attendance logic (no DB). Unit-tested in logic.test.ts. */

export const STATUSES = ["present", "late", "excused", "absent"] as const;
export type AttendanceStatus = (typeof STATUSES)[number];
export type StatusPoints = Record<AttendanceStatus, number>;

export type GradeSession = {
  id: string;
  /** Attendance was taken (by a teacher) for this session. */
  taken: boolean;
};

/**
 * A learner's attendance summary over the sessions that apply to them.
 * A session counts once it was taken or the learner has a record in it
 * (self-marked); taken sessions without a record count as absent.
 * grade = earned / max possible × gradeMax (null when nothing counts yet).
 */
export function computeAttendance(input: {
  sessions: GradeSession[];
  records: Map<string, AttendanceStatus> | Record<string, AttendanceStatus>;
  statusPoints: StatusPoints;
  gradeMax: number;
}) {
  const records = input.records instanceof Map ? input.records : new Map(Object.entries(input.records));
  const best = Math.max(0, ...STATUSES.map((s) => input.statusPoints[s] ?? 0));
  const counts: Record<AttendanceStatus, number> = { present: 0, late: 0, excused: 0, absent: 0 };
  let earned = 0;
  let max = 0;
  let counted = 0;
  for (const s of input.sessions) {
    const status = records.get(s.id);
    if (!s.taken && !status) continue;
    const st = status ?? "absent";
    counts[st]++;
    earned += Math.max(0, input.statusPoints[st] ?? 0);
    max += best;
    counted++;
  }
  const ratio = max > 0 ? earned / max : null;
  return {
    sessions: counted,
    counts,
    earned,
    max,
    percentage: ratio === null ? null : Math.round(ratio * 10_000) / 100,
    grade: ratio === null ? null : Math.round(ratio * input.gradeMax * 100_000) / 100_000,
  };
}

/** Weekly repetition: start, start+7d, … up to and including `until` (capped). */
export function weeklyOccurrences(start: Date, until: Date | null | undefined, cap = 52) {
  const out = [new Date(start)];
  if (!until) return out;
  const week = 7 * 24 * 60 * 60 * 1000;
  for (let t = start.getTime() + week; t <= until.getTime() && out.length < cap; t += week) out.push(new Date(t));
  return out;
}

/** Self-marking is open from the session start until its end. */
export function withinSession(session: { startsAt: Date; durationMinutes: number }, now = new Date()) {
  const start = session.startsAt.getTime();
  return now.getTime() >= start && now.getTime() <= start + session.durationMinutes * 60_000;
}

const csvCell = (v: unknown) => {
  let s = v === null || v === undefined ? "" : String(v);
  // Neutralize spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(rows: unknown[][]) {
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
