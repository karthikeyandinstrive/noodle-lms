"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ErrorAlert } from "@/components/common";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, ApiError, errorMessage } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { statusLabel } from "./index";
import { api12, api2004, ScormSession, type Cmi, type ScormVersion } from "./runtime";

type Launch = {
  attemptId: string | null;
  attempt: number | null;
  version: ScormVersion;
  mode: "normal" | "browse" | "review";
  contentUrl: string;
  cmi: Cmi;
  multiSco: boolean;
};

type CommitResult = { status: string; scoreRaw: number | null; scoreMax: number | null; totalTimeSeconds: number; rejected: { key: string; reason: string }[] };

type ApiWindow = Window & { API?: unknown; API_1484_11?: unknown };

/**
 * Commits with fetch (not sendBeacon, which is POST-only): `keepalive` lets the
 * request outlive the page on pagehide. keepalive bodies are limited to 64 KB.
 */
async function sendCommit(activityId: string, attemptId: string, cmi: Cmi, finish: boolean, keepalive: boolean): Promise<CommitResult> {
  const body = JSON.stringify({ cmi, finish });
  const res = await fetch(`/api/v1/scorm/${activityId}/attempts/${attemptId}/commit`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body,
    credentials: "same-origin",
    keepalive: keepalive && body.length < 60_000,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? "ERROR", data?.error?.message ?? res.statusText);
  return data as CommitResult;
}

export function ScormPlayerPage() {
  const t = useT();
  const qc = useQueryClient();
  const { activityId } = useParams<{ activityId: string }>();
  const [launch, setLaunch] = useState<Launch | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [status, setStatus] = useState<string | null>(null);
  const session = useRef<ScormSession | null>(null);
  // Keeps the session effect from re-running (and resetting the runtime) when the locale changes.
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);

  // Start or resume the attempt once (?new=1 asks for a new attempt).
  useEffect(() => {
    let cancelled = false;
    const newAttempt = new URLSearchParams(window.location.search).get("new") === "1";
    api<Launch>(`/scorm/${activityId}/attempts`, { body: { newAttempt } })
      .then((l) => {
        if (!cancelled) setLaunch(l);
      })
      .catch((err) => {
        if (!cancelled) setError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [activityId]);

  // Install the API on this (the page) window before the SCO loads; remove it on leave.
  useEffect(() => {
    if (!launch) return;
    const attemptId = launch.attemptId;
    const s = new ScormSession(
      launch.version,
      launch.cmi,
      attemptId
        ? async (cmi, { finish, keepalive }) => {
            const r = await sendCommit(activityId, attemptId, cmi, finish, keepalive);
            setStatus(r.status);
            if (r.rejected.length) console.warn("SCORM: elements rejected by the server", r.rejected);
          }
        : null,
      (err) => toast.error(tRef.current("scorm.commitFailed", "Your progress could not be saved: {error}", { error: errorMessage(err) })),
    );
    session.current = s;
    const w = window as ApiWindow;
    if (launch.version === "1.2") w.API = api12(s);
    else w.API_1484_11 = api2004(s);

    const onPageHide = (e: PageTransitionEvent) => s.pageHide(!e.persisted);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      s.pageHide(true);
      delete w.API;
      delete w.API_1484_11;
      session.current = null;
      void qc.invalidateQueries({ queryKey: ["scorm", activityId] });
      void qc.invalidateQueries({ queryKey: ["activity", activityId] });
    };
  }, [launch, activityId, qc]);

  const back = (
    <Link href={`/activities/${activityId}`} className="inline-flex items-center gap-1 rounded-sm text-sm text-muted-foreground hover:text-foreground">
      <ChevronLeft aria-hidden className="size-4" /> {t("scorm.exit", "Exit activity")}
    </Link>
  );

  if (error) {
    return (
      <div className="space-y-4">
        {back}
        <ErrorAlert error={error} />
      </div>
    );
  }
  if (!launch) return <Skeleton className="h-[70vh] w-full" />;

  return (
    <div className="flex h-[calc(100dvh-7rem)] min-h-[480px] flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {back}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {launch.attempt !== null && <Badge variant="outline">{t("scorm.attemptN", "Attempt {n}", { n: launch.attempt })}</Badge>}
          {launch.mode === "browse" && <Badge variant="secondary">{t("scorm.preview", "Preview — nothing is recorded")}</Badge>}
          {status && <Badge>{statusLabel(t, status)}</Badge>}
          <Link href={`/activities/${activityId}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
            {t("scorm.saveExit", "Save and exit")}
          </Link>
        </div>
      </div>
      {launch.multiSco && (
        <Alert>
          <AlertDescription>{t("scorm.multiSco", "This package contains several SCOs. Only the first one is played.")}</AlertDescription>
        </Alert>
      )}
      <iframe
        src={launch.contentUrl}
        title={t("scorm.contentTitle", "SCORM content")}
        className="w-full flex-1 rounded-xl border bg-white"
        allow="fullscreen; autoplay"
        allowFullScreen
      />
    </div>
  );
}
