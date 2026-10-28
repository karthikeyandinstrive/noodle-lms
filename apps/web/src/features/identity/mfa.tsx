"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Download, KeyRound, ShieldCheck, ShieldOff } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ErrorAlert, QueryState, formatDate } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { meKey } from "@/lib/session";
import type { MfaStatus } from "./types";

export const mfaKey = ["auth", "mfa"] as const;

/** 6-digit TOTP input (numeric keyboard, one-time-code autofill). */
export function OtpInput({ id, value, onChange, autoFocus }: { id: string; value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  return (
    <Input
      id={id}
      name="code"
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="\d{6}"
      maxLength={6}
      required
      autoFocus={autoFocus}
      className="text-center font-mono text-lg tracking-[0.4em]"
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
    />
  );
}

/** Shows freshly generated recovery codes once, with copy and download. */
export function RecoveryCodes({ codes }: { codes: string[] }) {
  const t = useT();
  const text = codes.join("\n");
  const download = () => {
    const blob = new Blob([`${t("mfa.recoveryFileHeader", "Two-factor recovery codes. Each code works once.")}\n\n${text}\n`], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "recovery-codes.txt";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {t("mfa.recoveryHelp", "Save these codes somewhere safe. Each one can be used once if you lose your device. They won't be shown again.")}
      </p>
      <ul className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/40 p-3 font-mono text-sm" aria-label={t("mfa.recoveryCodes", "Recovery codes")}>
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            void navigator.clipboard.writeText(text).then(
              () => toast.success(t("mfa.copied", "Copied")),
              () => toast.error(t("mfa.copyFailed", "Couldn't copy")),
            )
          }
        >
          <Copy aria-hidden /> {t("mfa.copy", "Copy")}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={download}>
          <Download aria-hidden /> {t("mfa.download", "Download")}
        </Button>
      </div>
    </div>
  );
}

/** Setup → scan QR → confirm a code → show recovery codes. */
export function MfaEnrollment({ onDone }: { onDone: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const setup = useMutation({
    mutationFn: () => api<{ secret: string; otpauthUri: string; qrCodeDataUrl: string }>("/auth/mfa/setup", { body: {} }),
    onError: setError,
  });
  const enable = useMutation({
    mutationFn: () => api<{ recoveryCodes: string[] }>("/auth/mfa/enable", { body: { code } }),
    onSuccess: (r) => {
      setCodes(r.recoveryCodes);
      void qc.invalidateQueries({ queryKey: mfaKey });
      void qc.invalidateQueries({ queryKey: meKey });
    },
    onError: setError,
  });

  if (codes) {
    return (
      <div className="space-y-4">
        <p className="flex items-center gap-2 font-medium">
          <ShieldCheck className="size-5 text-primary" aria-hidden /> {t("mfa.enabledNow", "Two-factor authentication is on.")}
        </p>
        <RecoveryCodes codes={codes} />
        <Button onClick={onDone}>{t("mfa.savedCodes", "I've saved my codes")}</Button>
      </div>
    );
  }

  if (!setup.data) {
    return (
      <div className="space-y-3">
        {error ? <ErrorAlert error={error} /> : null}
        <p className="text-sm text-muted-foreground">
          {t("mfa.intro", "Use an authenticator app (such as Google Authenticator, Microsoft Authenticator or 1Password) to generate sign-in codes.")}
        </p>
        <Button
          onClick={() => {
            setError(null);
            setup.mutate();
          }}
          disabled={setup.isPending}
        >
          <KeyRound aria-hidden /> {setup.isPending ? t("common.pleaseWait", "Please wait…") : t("mfa.setUp", "Set up two-factor authentication")}
        </Button>
      </div>
    );
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        enable.mutate();
      }}
    >
      {error ? <ErrorAlert error={error} /> : null}
      <ol className="list-decimal space-y-1 pl-5 text-sm">
        <li>{t("mfa.step1", "Scan this QR code with your authenticator app.")}</li>
        <li>{t("mfa.step2", "Enter the 6-digit code it shows.")}</li>
      </ol>
      {/* eslint-disable-next-line @next/next/no-img-element -- data URL from the API */}
      <img src={setup.data.qrCodeDataUrl} alt={t("mfa.qrAlt", "QR code for your authenticator app")} width={200} height={200} className="rounded-md border bg-white p-2" />
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">{t("mfa.cantScan", "Can't scan? Enter this key instead")}</summary>
        <code className="mt-2 block break-all rounded bg-muted p-2 font-mono text-xs">{setup.data.secret.replace(/(.{4})/g, "$1 ").trim()}</code>
      </details>
      <div className="space-y-1.5">
        <Label htmlFor="mfa-enable-code">{t("mfa.code", "Authentication code")}</Label>
        <OtpInput id="mfa-enable-code" value={code} onChange={setCode} autoFocus />
      </div>
      <Button type="submit" disabled={enable.isPending || code.length !== 6}>
        {enable.isPending ? t("common.pleaseWait", "Please wait…") : t("mfa.verifyEnable", "Verify and turn on")}
      </Button>
    </form>
  );
}

/** Asks for the password or a current code, then runs the action (disable / regenerate). */
function ReauthDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  destructive,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: (body: { password: string } | { code: string }) => Promise<void>;
}) {
  const t = useT();
  const [mode, setMode] = useState<"code" | "password">("code");
  const [value, setValue] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const close = (o: boolean) => {
    if (!o) {
      setValue("");
      setError(null);
    }
    onOpenChange(o);
  };
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            setPending(true);
            try {
              await onConfirm(mode === "code" ? { code: value } : { password: value });
              close(false);
            } catch (err) {
              setError(err);
            } finally {
              setPending(false);
            }
          }}
        >
          {error ? <ErrorAlert error={error} /> : null}
          {mode === "code" ? (
            <div className="space-y-1.5">
              <Label htmlFor="mfa-reauth-code">{t("mfa.code", "Authentication code")}</Label>
              <OtpInput id="mfa-reauth-code" value={value} onChange={setValue} autoFocus />
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="mfa-reauth-password">{t("auth.password", "Password")}</Label>
              <Input id="mfa-reauth-password" type="password" autoComplete="current-password" required value={value} onChange={(e) => setValue(e.target.value)} />
            </div>
          )}
          <button
            type="button"
            className="text-sm text-primary hover:underline"
            onClick={() => {
              setMode(mode === "code" ? "password" : "code");
              setValue("");
            }}
          >
            {mode === "code" ? t("mfa.usePassword", "Use my password instead") : t("mfa.useCode", "Use an authentication code instead")}
          </button>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => close(false)}>
              {t("common.cancel", "Cancel")}
            </Button>
            <Button type="submit" variant={destructive ? "destructive" : "default"} disabled={pending || !value}>
              {pending ? t("common.pleaseWait", "Please wait…") : confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Profile → security: two-factor authentication. */
export function MfaCard() {
  const t = useT();
  const qc = useQueryClient();
  const status = useQuery({ queryKey: mfaKey, queryFn: () => api<MfaStatus>("/auth/mfa/status") });
  const [enrolling, setEnrolling] = useState(false);
  const [dialog, setDialog] = useState<"disable" | "regenerate" | null>(null);
  const [newCodes, setNewCodes] = useState<string[] | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: mfaKey });
    void qc.invalidateQueries({ queryKey: meKey });
  };
  const s = status.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {t("mfa.title", "Two-factor authentication")}
          {s?.enabled ? <Badge variant="secondary">{t("mfa.on", "On")}</Badge> : s ? <Badge variant="outline">{t("mfa.off", "Off")}</Badge> : null}
        </CardTitle>
        <CardDescription>{t("mfa.description", "Protect your account with a code from your phone in addition to your password.")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <QueryState query={status}>
          {s?.required && !s.enabled && (
            <p className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm" role="status">
              {t("mfa.requiredNotice", "Your organization requires administrators to use two-factor authentication.")}
            </p>
          )}
          {newCodes ? (
            <div className="space-y-3">
              <RecoveryCodes codes={newCodes} />
              <Button variant="outline" onClick={() => setNewCodes(null)}>
                {t("common.done", "Done")}
              </Button>
            </div>
          ) : s?.enabled ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                {t("mfa.enabledSince", "Enabled {date}. {count} recovery codes left.", { date: formatDate(s.enabledAt, false), count: s.recoveryCodesRemaining })}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => setDialog("regenerate")}>
                  <KeyRound aria-hidden /> {t("mfa.regenerate", "New recovery codes")}
                </Button>
                <Button variant="outline" onClick={() => setDialog("disable")}>
                  <ShieldOff aria-hidden /> {t("mfa.disable", "Turn off")}
                </Button>
              </div>
            </div>
          ) : enrolling ? (
            <MfaEnrollment
              onDone={() => {
                setEnrolling(false);
                refresh();
              }}
            />
          ) : (
            <Button onClick={() => setEnrolling(true)}>
              <ShieldCheck aria-hidden /> {t("mfa.setUp", "Set up two-factor authentication")}
            </Button>
          )}
        </QueryState>
      </CardContent>
      <ReauthDialog
        open={dialog === "disable"}
        onOpenChange={(o) => setDialog(o ? "disable" : null)}
        title={t("mfa.disableTitle", "Turn off two-factor authentication?")}
        description={t("mfa.disableHelp", "Confirm with a code from your authenticator app or your password.")}
        confirmLabel={t("mfa.disable", "Turn off")}
        destructive
        onConfirm={async (body) => {
          await api("/auth/mfa/disable", { body });
          toast.success(t("mfa.disabledToast", "Two-factor authentication turned off"));
          refresh();
        }}
      />
      <ReauthDialog
        open={dialog === "regenerate"}
        onOpenChange={(o) => setDialog(o ? "regenerate" : null)}
        title={t("mfa.regenerateTitle", "Generate new recovery codes?")}
        description={t("mfa.regenerateHelp", "Your current recovery codes will stop working.")}
        confirmLabel={t("mfa.regenerateConfirm", "Generate")}
        onConfirm={async (body) => {
          const r = await api<{ recoveryCodes: string[] }>("/auth/mfa/recovery-codes/regenerate", { body });
          setNewCodes(r.recoveryCodes);
          refresh();
        }}
      />
    </Card>
  );
}
