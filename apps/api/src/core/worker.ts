import { dispatchPendingEvents } from "./events";
import { runDueJobs } from "./jobs";
import { logger } from "./logger";

type Tick = { name: string; everyMs: number; run: () => Promise<unknown> };

const ticks: Tick[] = [
  { name: "jobs", everyMs: 1000, run: () => runDueJobs(10) },
  { name: "events", everyMs: 2000, run: () => dispatchPendingEvents(50) },
];

/** Adds a periodic task to the worker loop (the scheduler registers itself here). */
export function addWorkerTick(tick: Tick) {
  ticks.push(tick);
}

/**
 * Background loop: runs durable jobs, dispatches outbox events and scheduled
 * tasks. Started by server.ts (RUN_WORKER, default true) or by the dedicated
 * `worker.ts` entry point when you scale workers separately from the API.
 */
export function startWorker() {
  let stopped = false;
  const timers: NodeJS.Timeout[] = [];
  for (const tick of ticks) {
    let busy = false;
    const timer = setInterval(async () => {
      if (stopped || busy) return;
      busy = true;
      try {
        await tick.run();
      } catch (err) {
        logger.error({ err, tick: tick.name }, "worker tick failed");
      } finally {
        busy = false;
      }
    }, tick.everyMs);
    timers.push(timer);
  }
  logger.info({ ticks: ticks.map((t) => t.name) }, "background worker started");
  return () => {
    stopped = true;
    for (const t of timers) clearInterval(t);
  };
}
