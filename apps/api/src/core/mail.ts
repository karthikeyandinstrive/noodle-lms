import nodemailer from "nodemailer";
import { config } from "../config";
import { logger } from "./logger";

const transport = config.SMTP_URL ? nodemailer.createTransport(config.SMTP_URL) : null;

/** Sends an email via SMTP; in development without SMTP_URL, logs it instead. */
export async function sendMail(input: { to: string; subject: string; text: string; html?: string }) {
  if (!transport) {
    logger.info({ to: input.to, subject: input.subject, text: input.text }, "📧 email (SMTP_URL not set, not sent)");
    return;
  }
  await transport.sendMail({ from: config.MAIL_FROM, ...input });
}
