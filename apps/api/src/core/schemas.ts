import { z } from "zod";

/** Shared Zod building blocks for request/response schemas (they also generate the OpenAPI spec). */

export const zId = z.string().uuid();
export const zIdParam = z.object({ id: zId });
export const zDate = z.date();
export const zDateInput = z.coerce.date();
export const zNullableDate = z.date().nullable();

export const zPagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type Pagination = z.infer<typeof zPagination>;

export const paged = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), total: z.number().int(), page: z.number().int(), pageSize: z.number().int() });

export const offset = (p: Pagination) => (p.page - 1) * p.pageSize;

/**
 * PATCH body from a create schema: every field optional and **no defaults**.
 * In zod 4, `.partial()` still applies `.default()` values, so a PATCH that
 * omits a field would silently reset it. Always use this for updates.
 */
export function patchSchema<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(schema.shape) as [string, z.ZodType][]) {
    let inner: z.ZodType = field;
    while (inner instanceof z.ZodDefault || inner instanceof z.ZodPrefault) inner = inner.unwrap() as z.ZodType;
    shape[key] = inner.optional();
  }
  return z.object(shape) as unknown as ReturnType<z.ZodObject<{ [K in keyof T]: T[K] extends z.ZodDefault<infer I extends z.ZodType> ? I : T[K] }>["partial"]>;
}

export const zOk = z.object({ ok: z.literal(true) });
export const ok = { ok: true as const };

export const zUserSummary = z.object({
  id: zId,
  firstName: z.string(),
  lastName: z.string(),
  email: z.string().optional(),
});

/** Standard error envelope returned by the error handler. */
export const zError = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});
