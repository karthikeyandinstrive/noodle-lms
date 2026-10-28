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
