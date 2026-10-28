import { logger } from "./logger";

/**
 * Minimal background job runner: retries with exponential backoff, never
 * blocks the request. Swap for BullMQ (Redis) when running multiple API
 * replicas — callers only use `enqueue`.
 */
export function enqueue(name: string, fn: () => Promise<void>, attempts = 3) {
  const run = async (attempt: number) => {
    try {
      await fn();
    } catch (err) {
      if (attempt >= attempts) {
        logger.error({ err, job: name, attempt }, "job failed permanently");
        return;
      }
      setTimeout(() => void run(attempt + 1), 2 ** attempt * 1000).unref();
    }
  };
  setImmediate(() => void run(1));
}
