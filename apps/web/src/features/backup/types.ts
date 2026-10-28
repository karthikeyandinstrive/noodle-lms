/** Shapes returned by /api/v1/backups (mirror apps/api modules/backup/routes.ts). */

export type BackupStatus = "queued" | "running" | "done" | "failed";

export type BackupRecord = {
  id: string;
  kind: "backup" | "restore";
  status: BackupStatus;
  courseId: string | null;
  course: { id: string; fullname: string; shortname: string } | null;
  fileId: string | null;
  file: { id: string; filename: string; size: number } | null;
  options: Record<string, unknown>;
  report: {
    counts?: Record<string, number>;
    warnings?: string[];
    unsupported?: string[];
    size?: number;
    source?: { format?: string; version?: number; organization?: string; course?: string };
  };
  error: string | null;
  createdBy: string | null;
  createdAt: string;
  finishedAt: string | null;
};

export const isPending = (r: Pick<BackupRecord, "status">) => r.status === "queued" || r.status === "running";

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
