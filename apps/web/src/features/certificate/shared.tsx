"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

/** Shared bits for the certificate / badge / video features. */

export type IssueStatus = "valid" | "revoked" | "expired";

export function StatusBadge({ status }: { status: IssueStatus }) {
  if (status === "valid") return <Badge className="bg-emerald-600 text-white">Valid</Badge>;
  if (status === "expired") return <Badge variant="outline">Expired</Badge>;
  return <Badge variant="destructive">Revoked</Badge>;
}

/** Button that asks for confirmation before running a (destructive) action. */
export function ConfirmButton({
  children,
  title,
  description,
  confirmLabel = "Confirm",
  onConfirm,
  variant = "outline",
  size = "sm",
  disabled,
  "aria-label": ariaLabel,
}: {
  children: React.ReactNode;
  title: string;
  description?: string;
  confirmLabel?: string;
  onConfirm: () => Promise<unknown> | void;
  variant?: "outline" | "destructive" | "ghost" | "default";
  size?: "sm" | "xs" | "default" | "icon-sm";
  disabled?: boolean;
  "aria-label"?: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Button type="button" variant={variant} size={size} disabled={disabled} aria-label={ariaLabel} onClick={() => setOpen(true)}>
        {children}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            {description && <AlertDialogDescription>{description}</AlertDialogDescription>}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onConfirm();
                  setOpen(false);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Working…" : confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** ISO string ⇄ <input type="datetime-local"> value (local time). */
export const toLocalInput = (iso: string | null | undefined) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
export const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null);

export function formatBytes(n: number | null | undefined) {
  if (!n && n !== 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Opens a blank tab synchronously (so popup blockers allow it), then navigates it once the URL is known. */
export async function openInNewTab(getUrl: () => Promise<string>) {
  const win = window.open("", "_blank");
  try {
    const url = await getUrl();
    if (win) {
      win.opener = null;
      win.location.href = url;
    } else {
      window.location.href = url;
    }
  } catch (err) {
    win?.close();
    throw err;
  }
}

export const NativeSelectClass = "h-8 w-full rounded-lg border bg-background px-2 text-sm";
