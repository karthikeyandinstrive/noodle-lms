import type { FastifyRequest } from "fastify";
import { auditLogs, type DB } from "@lms/db";

/**
 * Records an administrative / security-relevant action. Call inside the same
 * transaction as the change so the log and the change commit together.
 * Never put secrets or passwords in `metadata`.
 */
export async function audit(
  tx: DB,
  req: FastifyRequest,
  action: string,
  target?: { type: string; id: string },
  metadata: Record<string, unknown> = {},
) {
  await tx.insert(auditLogs).values({
    organizationId: req.org.id,
    actorId: req.user?.id ?? null,
    action,
    targetType: target?.type ?? null,
    targetId: target?.id ?? null,
    metadata,
    ip: req.ip,
    userAgent: req.headers["user-agent"]?.slice(0, 500),
  });
}
