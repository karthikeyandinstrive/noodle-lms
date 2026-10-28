"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export const STATUSES = ["present", "late", "excused", "absent"] as const;
export type AttendanceStatus = (typeof STATUSES)[number];
export const STATUS_LABELS: Record<AttendanceStatus, string> = { present: "Present", late: "Late", excused: "Excused", absent: "Absent" };
export const STATUS_SHORT: Record<AttendanceStatus, string> = { present: "P", late: "L", excused: "E", absent: "A" };
export const STATUS_CLASSES: Record<AttendanceStatus, string> = {
  present: "bg-emerald-600 text-white hover:bg-emerald-600/90 dark:bg-emerald-500",
  late: "bg-amber-500 text-white hover:bg-amber-500/90",
  excused: "bg-sky-600 text-white hover:bg-sky-600/90 dark:bg-sky-500",
  absent: "bg-red-600 text-white hover:bg-red-600/90 dark:bg-red-500",
};

export type Person = { id: string; firstName: string; lastName: string };
export type Summary = {
  sessions: number;
  counts: Record<AttendanceStatus, number>;
  earned: number;
  max: number;
  percentage: number | null;
  grade: number | null;
};

export type AttendanceInfo = {
  gradeMax: number;
  statusPoints: Record<AttendanceStatus, number>;
  allowSelfMarking: boolean;
  canTake: boolean;
  canViewAll: boolean;
  canSelfMark: boolean;
  groups: { id: string; name: string }[];
  mySummary: Summary | null;
};

export type Session = {
  id: string;
  startsAt: string;
  durationMinutes: number;
  description: string | null;
  groupId: string | null;
  groupName: string | null;
  hasCode: boolean;
  takenAt: string | null;
  myStatus: AttendanceStatus | null;
  selfMarkOpen: boolean;
  recorded: number;
};

export type SessionDetail = Omit<Session, "myStatus" | "selfMarkOpen"> & {
  roster: { user: Person; status: AttendanceStatus | null; remarks: string | null; takenAt: string | null; selfMarked: boolean }[];
};

export type Report = {
  sessions: { id: string; startsAt: string; groupId: string | null; groupName: string | null; taken: boolean }[];
  rows: { user: Person; statuses: Record<string, AttendanceStatus | null>; summary: Summary }[];
};

export const attendanceKeys = {
  all: (id: string) => ["attendance", id] as const,
  info: (id: string) => ["attendance", id, "info"] as const,
  sessions: (id: string) => ["attendance", id, "sessions"] as const,
  session: (id: string, sessionId: string) => ["attendance", id, "session", sessionId] as const,
  report: (id: string) => ["attendance", id, "report"] as const,
};

export const useAttendanceInfo = (id: string) =>
  useQuery({ queryKey: attendanceKeys.info(id), queryFn: () => api<AttendanceInfo>(`/attendance/${id}`) });

export const useSessions = (id: string) =>
  useQuery({ queryKey: attendanceKeys.sessions(id), queryFn: () => api<Session[]>(`/attendance/${id}/sessions`), refetchInterval: 60_000 });

export const useSessionDetail = (id: string, sessionId: string) =>
  useQuery({ queryKey: attendanceKeys.session(id, sessionId), queryFn: () => api<SessionDetail>(`/attendance/${id}/sessions/${sessionId}`) });

export const useReport = (id: string, enabled: boolean) =>
  useQuery({ queryKey: attendanceKeys.report(id), queryFn: () => api<Report>(`/attendance/${id}/report`), enabled });

export const csvUrl = (id: string) => `/api/v1/attendance/${id}/report.csv`;

export function sessionTime(s: { startsAt: string; durationMinutes: number }) {
  const start = new Date(s.startsAt);
  const end = new Date(start.getTime() + s.durationMinutes * 60_000);
  const date = start.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const t = (d: Date) => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${date}, ${t(start)}–${t(end)}`;
}
