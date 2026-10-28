import { config } from "../../config";
import { logger } from "../../core/logger";

/** Startup checks for the payments module. */
export function setup() {
  if (!process.env.ENCRYPTION_KEY) {
    logger.warn("payments: ENCRYPTION_KEY is not set; gateway secrets are encrypted with the development fallback key");
  }
  if (config.isProd && !config.APP_URL.startsWith("https://")) {
    logger.warn("payments: APP_URL is not https; payment providers require https return and webhook URLs");
  }
}
