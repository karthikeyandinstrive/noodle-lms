import { closeDb } from "@lms/db";
import { buildApp } from "./app";
import { config } from "./config";

const app = await buildApp();

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await closeDb();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ port: config.PORT, host: config.HOST });
