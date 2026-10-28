"use client";

import { AlertCircle, Inbox } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between", className)}>
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

/** Standard loading / error wrapper for a TanStack query. */
export function QueryState({
  query,
  children,
  skeleton,
}: {
  query: { isPending: boolean; isError: boolean; error: unknown };
  children: React.ReactNode;
  skeleton?: React.ReactNode;
}) {
  if (query.isPending) {
    return (
      skeleton ?? (
        <div className="space-y-3" aria-busy="true">
          <LoadingLabel />
          <Skeleton className="h-8 w-1/3" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      )
    );
  }
  if (query.isError) return <ErrorAlert error={query.error} />;
  return <>{children}</>;
}

function LoadingLabel() {
  const t = useT();
  return (
    <span className="sr-only" role="status">
      {t("common.loading", "Loading…")}
    </span>
  );
}

export function ErrorAlert({ error, title }: { error: unknown; title?: string }) {
  const t = useT();
  return (
    <Alert variant="destructive" role="alert">
      <AlertCircle aria-hidden />
      <AlertTitle>{title ?? t("common.error", "Something went wrong")}</AlertTitle>
      <AlertDescription>{errorMessage(error)}</AlertDescription>
    </Alert>
  );
}

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed p-10 text-center">
      <Inbox aria-hidden className="mb-3 size-8 text-muted-foreground" />
      <p className="font-medium">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/**
 * Renders HTML that the API has already sanitized (sanitize-html on write).
 * Never pass unsanitized user input here.
 */
export function HtmlContent({ html, className }: { html: string | null | undefined; className?: string }) {
  if (!html) return null;
  return (
    <div
      className={cn("prose prose-sm max-w-none dark:prose-invert [&_a]:text-primary [&_a]:underline [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5", className)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p className="text-xs text-destructive" role="alert">
      {message}
    </p>
  );
}

/** Locale-neutral date formatting kept for compatibility; prefer `useFormat().date` in components. */
export function formatDate(value: string | Date | null | undefined, withTime = true) {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  return d.toLocaleString(undefined, withTime ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" });
}

export function fullName(u: { firstName: string; lastName: string } | null | undefined) {
  return u ? `${u.firstName} ${u.lastName}` : "";
}
