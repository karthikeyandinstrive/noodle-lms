import { pino } from "pino";
import { config } from "../config";

/** Shared logger for code that runs outside a request. Inside handlers prefer `req.log`. */
export const logger = pino({
  level: config.LOG_LEVEL,
  redact: { paths: ["*.password", "*.passwordHash", "*.secretAccessKey", "*.token", "req.headers.cookie", "req.headers.authorization"], censor: "[redacted]" },
});
