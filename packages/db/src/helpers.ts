import { and, eq, isNull } from "drizzle-orm";
import type { DB } from "./client";
import { contexts } from "./schema";

type ContextLevel = (typeof contexts.$inferSelect)["level"];

/** The organization's root (system) context. Created on organization signup. */
export async function getSystemContext(tx: DB, organizationId: string) {
  const [ctx] = await tx
    .select()
    .from(contexts)
    .where(and(eq(contexts.organizationId, organizationId), eq(contexts.level, "system"), isNull(contexts.instanceId)))
    .limit(1);
  if (!ctx) throw new Error(`System context missing for organization ${organizationId}`);
  return ctx;
}

/** Creates a child context, maintaining the materialized path used for permission inheritance. */
export async function createContext(
  tx: DB,
  input: { organizationId: string; level: ContextLevel; instanceId: string | null; parentId: string | null },
) {
  let parentPath = "";
  let depth = 0;
  if (input.parentId) {
    const [parent] = await tx.select().from(contexts).where(eq(contexts.id, input.parentId)).limit(1);
    if (!parent) throw new Error(`Parent context ${input.parentId} not found`);
    parentPath = parent.path;
    depth = parent.depth + 1;
  }
  const id = crypto.randomUUID();
  const [ctx] = await tx
    .insert(contexts)
    .values({
      id,
      organizationId: input.organizationId,
      level: input.level,
      instanceId: input.instanceId,
      parentId: input.parentId,
      path: `${parentPath}/${id}`,
      depth,
    })
    .returning();
  return ctx!;
}
