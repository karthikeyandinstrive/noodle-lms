import nodemailer from "nodemailer";
import type { DB } from "@lms/db";
import { config } from "../config";
import { defineJob, enqueueJob } from "./jobs";
import { logger } from "./logger";

const transport = config.SMTP_URL ? nodemailer.createTransport(config.SMTP_URL) : null;

export type MailMessage = { to: string; subject: string; text: string; html?: string };

/** Sends an email via SMTP right now; in development without SMTP_URL, logs it instead. */
export async function sendMail(input: MailMessage) {
  if (!transport) {
    logger.info({ to: input.to, subject: input.subject, text: input.text }, "📧 email (SMTP_URL not set, not sent)");
    return;
  }
  await transport.sendMail({ from: config.MAIL_FROM, ...input });
}

defineJob<MailMessage>("email.send", (msg) => sendMail(msg), { maxAttempts: 6, backoffSeconds: 60 });

/**
 * Queues an email as a durable job. Pass the request transaction so the email
 * is only sent if the change commits.
 */
export async function queueMail(tx: DB | null, tenantId: string | null, msg: MailMessage) {
  await enqueueJob(tx, "email.send", msg, { tenantId });
}
