export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, "BAD_REQUEST", message, details);
export const unauthorized = (message = "Authentication required") => new AppError(401, "UNAUTHORIZED", message);
export const forbidden = (message = "You do not have permission to do this") => new AppError(403, "FORBIDDEN", message);
export const notFound = (what = "Resource") => new AppError(404, "NOT_FOUND", `${what} not found`);
export const conflict = (message: string) => new AppError(409, "CONFLICT", message);
export const tooMany = (message = "Too many requests") => new AppError(429, "RATE_LIMITED", message);

/** Throws 404 when a lookup returned nothing. Never 403 for missing rows, to avoid leaking existence. */
export function must<T>(value: T | undefined | null, what?: string): T {
  if (value === undefined || value === null) throw notFound(what);
  return value;
}
