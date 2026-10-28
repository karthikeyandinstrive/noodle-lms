"use client";

import { ChevronLeft, ChevronRight, ShieldAlert } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";

/** Native select styled like the shadcn inputs (accessible, works well on mobile). */
export function NativeSelect({ className, ...props }: React.ComponentProps<"select">) {
  return <select className={cn("h-8 w-full min-w-0 rounded-lg border bg-background px-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50", className)} {...props} />;
}

/** Label + control + optional hint. */
export function Field({ id, label, hint, children, className }: { id?: string; label: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Previous/next pager for `paged()` API responses. */
export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize && page === 1) return <p className="mt-3 text-xs text-muted-foreground">{total} total</p>;
  return (
    <nav className="mt-4 flex items-center justify-between gap-2" aria-label="Pagination">
      <p className="text-xs text-muted-foreground">
        Page {page} of {pages} · {total} total
      </p>
      <div className="flex gap-1">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page">
          <ChevronLeft /> <span className="hidden sm:inline">Previous</span>
        </Button>
        <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page">
          <span className="hidden sm:inline">Next</span> <ChevronRight />
        </Button>
      </div>
    </nav>
  );
}

/** Renders children only when the current user has the site-level capability. The API re-checks. */
export function RequireCapability({ capability, children }: { capability: string | string[]; children: React.ReactNode }) {
  const session = useSession();
  if (session.isPending) return <Skeleton className="h-32 w-full" />;
  const caps = Array.isArray(capability) ? capability : [capability];
  if (!caps.some((c) => session.can(c))) {
    return (
      <Alert>
        <ShieldAlert />
        <AlertTitle>Not available</AlertTitle>
        <AlertDescription>You don&apos;t have permission to view this page.</AlertDescription>
      </Alert>
    );
  }
  return <>{children}</>;
}

type ConfirmProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  /** When set, the user must type this text exactly (destructive actions). */
  confirmText?: string;
  pending?: boolean;
  onConfirm: () => void;
  children?: React.ReactNode;
};

/** Body is mounted only while open, so the typed confirmation resets each time. */
function ConfirmBody({ onOpenChange, confirmLabel = "Confirm", destructive, confirmText, pending, onConfirm, children }: Omit<ConfirmProps, "open" | "title" | "description">) {
  const [typed, setTyped] = useState("");
  const blocked = !!confirmText && typed !== confirmText;
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!blocked && !pending) onConfirm();
      }}
    >
      {children}
      {confirmText && (
        <Field
          id="confirm-text"
          label={
            <span>
              Type <strong className="font-mono">{confirmText}</strong> to confirm
            </span>
          }
        >
          <Input id="confirm-text" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
        </Field>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" variant={destructive ? "destructive" : "default"} disabled={blocked || pending}>
          {pending ? "Working…" : confirmLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Confirmation dialog, optionally requiring typed confirmation. */
export function ConfirmDialog({ open, title, description, ...rest }: ConfirmProps) {
  return (
    <Dialog open={open} onOpenChange={rest.onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {open && <ConfirmBody {...rest} />}
      </DialogContent>
    </Dialog>
  );
}

/** Formats integer minor units (price × 100) for display. */
export function formatMoney(cents: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

const noopSubscribe = () => () => {};

/** Reads a query-string value (client only; null during server render). */
export function useSearchParam(name: string) {
  return useSyncExternalStore(
    noopSubscribe,
    () => new URLSearchParams(window.location.search).get(name),
    () => null,
  );
}
