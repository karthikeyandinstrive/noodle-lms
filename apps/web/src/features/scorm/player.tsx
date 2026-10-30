"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ErrorAlert } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { NativeSelect } from "@/features/admin/shared";
import { api, ApiError, errorMessage } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { statusLabel } from "./index";
import { api12, api2004, ScormSession, type Cmi, type ScormVersion } from "./runtime";

type ScoState = {
  identifier: string;
  title: string;
  status: string;
  available: boolean;
  hidden: boolean;
};
type Nav = {
  continue: string | null;
  previous: string | null;
  sequenced: boolean;
};

type Launch = {
  attemptId: string | null;
  attempt: number | null;
  version: ScormVersion;
  mode: "normal" | "browse" | "review";
  contentUrl: string;
  cmi: Cmi;
  multiSco: boolean;
  sco: string;
  scos: ScoState[];
  nav: Nav;
};

type CommitResult = {
  status: string;
  scoStatus: string;
  scoreRaw: number | null;
  scoreMax: number | null;
  totalTimeSeconds: number;
  rejected: { key: string; reason: string }[];
  scos?: ScoState[];
  nav?: Nav;
  /** After a sequenced SCO ends: the SCO to deliver next, "exit", or null. */
  next?: string | null;
};

/** What to launch: a lesson picked from the menu (choice) or the next/previous one (flow). */
type LaunchRequest = { sco: string } | { request: "continue" | "previous" };

type ApiWindow = Window & { API?: unknown; API_1484_11?: unknown };

/**
 * Commits with fetch (not sendBeacon, which is POST-only): `keepalive` lets the
 * request outlive the page on pagehide. keepalive bodies are limited to 64 KB.
 */
async function sendCommit(activityId: string, attemptId: string, sco: string, cmi: Cmi, finish: boolean, keepalive: boolean): Promise<CommitResult> {
  const body = JSON.stringify({ cmi, finish, sco });
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
  const router = useRouter();
  const { activityId } = useParams<{ activityId: string }>();
  const [launch, setLaunch] = useState<Launch | null>(null);
  /** Lesson states and navigation after the latest commit (fresher than the launch response). */
  const [navState, setNavState] = useState<{
    scos: ScoState[];
    nav: Nav;
  } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [status, setStatus] = useState<string | null>(null);
  /** SCO statuses committed during this visit (fresher than the launch response). */
  const [scoStatus, setScoStatus] = useState<Record<string, string>>({});
  const session = useRef<ScormSession | null>(null);
  const navStateRef = useRef(navState);
  useEffect(() => {
    navStateRef.current = navState;
  }, [navState]);
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

  // Multi-SCO: unmount the current SCO first (it finishes while the API is still installed),
  // then launch the requested one in the same attempt. The server checks the package's
  // sequencing rules against the SCO being left.
  const [switching, setSwitching] = useState(false);
  const go = (target: LaunchRequest) => {
    if (!launch || switching || ("sco" in target && target.sco === launch.sco)) return;
    const from = launch.sco;
    setSwitching(true);
    setLaunch(null);
    setNavState(null);
    api<Launch>(`/scorm/${activityId}/attempts`, { body: { ...target, from } })
      .then(setLaunch)
      .catch(setError)
      .finally(() => setSwitching(false));
  };

  /**
   * After the SCO terminates: its own navigation request (adl.nav.request) wins, then what the
   * package's post-condition rules decided on the server (`next`).
   */
  const afterFinish = useRef<(r: CommitResult, sco: string, request: string | undefined) => void>(() => {});
  useEffect(() => {
    afterFinish.current = (r, sco, request) => {
      // Ignore SCOs that terminate while the learner is already moving elsewhere.
      if (!launch || launch.sco !== sco || switching) return;
      const nav = r.nav ?? launch.nav;
      const choice = /^\{target=([^}]+)\}(choice|jump)$/.exec(request ?? "");
      if (choice) return go({ sco: choice[1]! });
      if (request && /^(exit|exitAll|suspendAll|abandon|abandonAll)$/.test(request)) return router.push(`/activities/${activityId}`);
      const next = r.next;
      if (next === "exit") return router.push(`/activities/${activityId}`);
      if (!next) return;
      if (next === nav.continue) go({ request: "continue" });
      else if (next === nav.previous) go({ request: "previous" });
      else go({ sco: next });
    };
  });

  // Install the API on this (the page) window before the SCO loads; remove it on leave.
  useEffect(() => {
    if (!launch) return;
    const attemptId = launch.attemptId;
    const sco = launch.sco;
    const s = new ScormSession(
      launch.version,
      launch.cmi,
      attemptId
        ? async (cmi, { finish, keepalive }) => {
            const r = await sendCommit(activityId, attemptId, sco, cmi, finish, keepalive);
            setStatus(r.status);
            setScoStatus((prev) => ({ ...prev, [sco]: r.scoStatus }));
            if (r.scos && r.nav) setNavState({ scos: r.scos, nav: r.nav });
            if (r.rejected.length) console.warn("SCORM: elements rejected by the server", r.rejected);
            // keepalive commits happen as the page goes away: no navigation then.
            if (finish && !keepalive && launch.multiSco) afterFinish.current(r, sco, s.values["adl.nav.request"]);
          }
        : null,
      (err) => toast.error(tRef.current("scorm.commitFailed", "Your progress could not be saved: {error}", { error: errorMessage(err) })),
      (request) => {
        const nav = navStateRef.current?.nav ?? launch.nav;
        const scos = navStateRef.current?.scos ?? launch.scos;
        if (request === "continue") return nav.continue ? "true" : "false";
        if (request === "previous") return nav.previous ? "true" : "false";
        const target = /\{target=([^}]+)\}/.exec(request)?.[1];
        const item = scos.find((x) => x.identifier === target);
        return item?.available && !item.hidden ? "true" : "false";
      },
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

  const scos = navState?.scos ?? launch.scos;
  const nav = navState?.nav ?? launch.nav;
  const scoLabel = (x: ScoState, i: number) =>
    t("scorm.scoOption", "{n}. {title} ({status})", {
      n: i + 1,
      title: x.title,
      status: statusLabel(t, scoStatus[x.identifier] ?? x.status),
    });

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
        <nav aria-label={t("scorm.lessons", "Lessons in this package")} className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" disabled={!nav.previous || switching} onClick={() => go({ request: "previous" })}>
            <ChevronLeft aria-hidden /> {t("scorm.previous", "Previous")}
          </Button>
          <label htmlFor="scorm-sco" className="sr-only">
            {t("scorm.lesson", "Lesson")}
          </label>
          <NativeSelect
            id="scorm-sco"
            className="min-w-0 flex-1 sm:max-w-md"
            value={launch.sco}
            disabled={switching}
            onChange={(e) => go({ sco: e.target.value })}
          >
            {scos.map((x, i) =>
              x.hidden && x.identifier !== launch.sco ? null : (
                <option key={x.identifier} value={x.identifier} disabled={!x.available}>
                  {x.available
                    ? scoLabel(x, i)
                    : t("scorm.scoLocked", "{label} — not available", {
                        label: scoLabel(x, i),
                      })}
                </option>
              ),
            )}
          </NativeSelect>
          <Button variant="outline" size="sm" disabled={!nav.continue || switching} onClick={() => go({ request: "continue" })}>
            {t("scorm.next", "Next")} <ChevronRight aria-hidden />
          </Button>
        </nav>
      )}
      <iframe
        key={launch.contentUrl}
        src={launch.contentUrl}
        title={t("scorm.contentTitle", "SCORM content")}
        className="w-full flex-1 rounded-xl border bg-white"
        allow="fullscreen; autoplay"
        allowFullScreen
      />
    </div>
  );
}
