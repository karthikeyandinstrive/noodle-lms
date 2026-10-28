import { closeDb } from "@lms/db";
import { buildApp } from "./app";
import { config } from "./config";
import { startWorker } from "./core/worker";

const app = await buildApp();
// Run the background worker in-process unless it is deployed separately (src/worker.ts).
const stopWorker = process.env.RUN_WORKER === "false" ? () => {} : startWorker();

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  stopWorker();
  await app.close();
  await closeDb();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ port: config.PORT, host: config.HOST });
