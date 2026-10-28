/**
 * Typed fetch wrapper for the LMS API. Requests go to the same origin
 * (`/api/v1/...`), which Next.js proxies to the API service, so the
 * httpOnly session cookie is sent automatically.
 */

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | null | undefined>;

export type RequestOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Query;
  signal?: AbortSignal;
};

function buildUrl(path: string, query?: Query) {
  const url = `/api/v1${path.startsWith("/") ? path : `/${path}`}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

export async function api<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await fetch(buildUrl(path, opts.query), {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers: opts.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: "same-origin",
    signal: opts.signal,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = data?.error ?? {};
    throw new ApiError(res.status, err.code ?? "ERROR", err.message ?? res.statusText, err.details);
  }
  return data as T;
}

export type UploadedFile = { id: string; filename: string; mimeType: string; size: number; status: string };

/**
 * Uploads a file directly to storage: ask the API for a presigned URL,
 * PUT the bytes there, then confirm.
 */
export async function uploadFile(
  file: File,
  target: { component?: string; area?: string } = {},
): Promise<UploadedFile> {
  const start = await api<{ file: UploadedFile; uploadUrl: string; headers: Record<string, string> }>("/files/uploads", {
    body: {
      component: target.component ?? "draft",
      area: target.area ?? "draft",
      filename: file.name,
      mimeType: file.type || "application/octet-stream",
      size: file.size,
    },
  });
  const put = await fetch(start.uploadUrl, { method: "PUT", headers: start.headers, body: file });
  if (!put.ok) throw new ApiError(put.status, "UPLOAD_FAILED", "Upload failed");
  return api<UploadedFile>(`/files/${start.file.id}/complete`, { method: "POST", body: {} });
}

/** URL that redirects to a short-lived signed download link. */
export const fileUrl = (fileId: string, inline = false) => `/api/v1/files/${fileId}${inline ? "?inline=true" : ""}`;

export function errorMessage(err: unknown) {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong";
}

export type Paged<T> = { items: T[]; total: number; page: number; pageSize: number };
