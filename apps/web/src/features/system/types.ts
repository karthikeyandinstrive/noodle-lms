export type ServiceStatus = "ok" | "error" | "disabled";

export type SystemHealth = {
  version: string;
  db: ServiceStatus;
  redis: ServiceStatus;
  queue: {
    depth: number;
    oldestQueuedAgeSeconds: number | null;
    failedJobs: number;
    undispatchedEvents: number;
    failedEvents: number;
  };
  tasks: { name: string; intervalSeconds: number; lastRunAt: string | null; running: boolean }[];
};

export const JOB_STATUSES = ["queued", "running", "done", "failed"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export type SystemJob = {
  id: string;
  name: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  runAt: string;
  createdAt: string;
  finishedAt: string | null;
  lastError: string | null;
};

export type FailedEvent = {
  id: string;
  name: string;
  attempts: number;
  lastError: string | null;
  completedHandlers: string[];
  createdAt: string;
  nextAttemptAt: string;
  dispatchedAt: string | null;
  gaveUp: boolean;
};
