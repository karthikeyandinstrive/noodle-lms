import { closeDb } from "@lms/db";
import { buildApp } from "./app";
import { startWorker } from "./core/worker";

// Dedicated worker process: builds the app (registers modules, jobs and
// subscribers) without listening, then runs the background loop.
const app = await buildApp();
await app.ready();
const stop = startWorker();

const shutdown = async () => {
  stop();
  await app.close();
  await closeDb();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
