"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Paperclip, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { EmptyState, fullName, QueryState } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, ApiError, errorMessage, uploadFile } from "@/lib/api";
import { useFormat, useT } from "@/lib/i18n";
import type { UserSummary } from "@/lib/types";
import type { ActivityTypeUI, ActivityViewProps, SettingsFieldsProps } from "../activities/types";
import { isAllowedEmbedSrc, normalizeEmbedUrl } from "./embed";

type InteractiveSettings = {
  kind: "h5p" | "embed";
  embedUrl: string | null;
  embedProvider: string | null;
  packageFileId: string | null;
  h5p: { title: string; mainLibrary: string } | null;
  gradeMax: number;
};

type MyResults = { attempts: { id: string; rawScore: number | null; maxScore: number | null; completed: boolean; createdAt: string }[]; bestPercent: number | null; gradeMax: number };
type ResultRow = { user: UserSummary; attempts: number; bestPercent: number | null; completed: boolean; lastAttemptAt: string | null };

const resultsKey = (id: string) => ["interactive", id, "results"] as const;
const myResultsKey = (id: string) => ["interactive", id, "results", "me"] as const;

// ─── Embeds ─────────────────────────────────────────────────────────────────

function EmbedFrame({ src, title }: { src: string; title: string }) {
  const t = useT();
  if (!isAllowedEmbedSrc(src))
    return (
      <p className="text-sm text-destructive" role="alert">
        {t("interactive.notAllowed", "This embedded content is not from an allowed provider.")}
      </p>
    );
  return (
    <div className="relative w-full overflow-hidden rounded-xl border bg-muted" style={{ aspectRatio: "16 / 9" }}>
      <iframe
        src={src}
        title={title}
        className="absolute inset-0 size-full"
        sandbox="allow-scripts allow-same-origin allow-forms"
        allow="fullscreen; encrypted-media; picture-in-picture"
        allowFullScreen
        referrerPolicy="strict-origin-when-cross-origin"
        loading="lazy"
      />
    </div>
  );
}

// ─── H5P player (sandboxed, opaque origin) ──────────────────────────────────

type XapiMessage = { type: "lms-h5p:xapi"; rawScore: number | null; maxScore: number | null; completed: boolean; statement?: Record<string, unknown> };

function H5pPlayer({ activityId, title, canRecord }: { activityId: string; title: string; canRecord: boolean }) {
  const qc = useQueryClient();
  const t = useT();
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(480);
  const last = useRef<{ key: string; at: number } | null>(null);
  const launch = useQuery({
    queryKey: ["interactive", activityId, "launch"],
    queryFn: () => api<{ playerUrl: string }>(`/interactive/${activityId}/launch`),
    staleTime: 60 * 60_000,
  });

  const record = useMutation({
    mutationFn: (m: XapiMessage) =>
      api<{ bestPercent: number | null }>(`/interactive/${activityId}/result`, {
        body: { rawScore: m.rawScore, maxScore: m.maxScore, completed: m.completed, statement: m.statement },
      }),
    onSuccess: (r) => {
      if (r.bestPercent !== null) toast.success(t("interactive.resultSaved", "Result saved · best score {percent}%", { percent: r.bestPercent }));
      void qc.invalidateQueries({ queryKey: myResultsKey(activityId) });
      void qc.invalidateQueries({ queryKey: ["activity", activityId] });
    },
    onError: (err) => {
      // Teachers previewing (not enrolled) cannot record results: stay quiet.
      if (!(err instanceof ApiError && err.status === 403)) toast.error(errorMessage(err));
    },
  });

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      // The sandboxed player has an opaque origin ("null"): trust only messages from our iframe.
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const d = e.data as { type?: string } | null;
      if (!d || typeof d !== "object") return;
      if (d.type === "lms-h5p:resize") {
        const h = Number((d as { height?: unknown }).height);
        if (Number.isFinite(h)) setHeight(Math.min(4000, Math.max(240, Math.round(h) + 4)));
      }
      if (d.type === "lms-h5p:xapi" && canRecord) {
        const m = d as XapiMessage;
        const valid = (m.rawScore === null && m.maxScore === null) || (typeof m.rawScore === "number" && typeof m.maxScore === "number" && m.maxScore > 0);
        if (!valid || (m.rawScore === null && !m.completed)) return;
        // H5P often emits "answered" and "completed" together: de-duplicate identical results.
        const key = `${m.rawScore}/${m.maxScore}/${m.completed}`;
        const now = Date.now();
        if (last.current && last.current.key === key && now - last.current.at < 5000) return;
        last.current = { key, at: now };
        record.mutate({ ...m, statement: typeof m.statement === "object" && m.statement ? m.statement : undefined });
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [canRecord, record]);

  return (
    <QueryState query={launch}>
      {launch.data && (
        <iframe
          ref={frame}
          src={launch.data.playerUrl}
          title={title}
          // No allow-same-origin: package code runs in an opaque origin, isolated from the LMS session.
          sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
          allow="fullscreen"
          allowFullScreen
          className="w-full rounded-xl border bg-white"
          style={{ height }}
        />
      )}
    </QueryState>
  );
}

function MyResultsCard({ activityId }: { activityId: string }) {
  const t = useT();
  const q = useQuery({ queryKey: myResultsKey(activityId), queryFn: () => api<MyResults>(`/interactive/${activityId}/results/me`) });
  if (!q.data || !q.data.attempts.length) return null;
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>
          <h2>{t("interactive.yourResults", "Your results")}</h2>
        </CardTitle>
        <CardDescription>
          {q.data.attempts.length === 1
            ? t("interactive.attempts.one", "{count} attempt", { count: q.data.attempts.length })
            : t("interactive.attempts.other", "{count} attempts", { count: q.data.attempts.length })}
          {q.data.bestPercent !== null && <> · {t("interactive.bestScore", "best score {percent}%", { percent: q.data.bestPercent })}</>}
        </CardDescription>
      </CardHeader>
    </Card>
  );
}

function ResultsTable({ activityId }: { activityId: string }) {
  const t = useT();
  const fmt = useFormat();
  const q = useQuery({ queryKey: resultsKey(activityId), queryFn: () => api<ResultRow[]>(`/interactive/${activityId}/results`) });
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 id="interactive-results">{t("interactive.learnerResults", "Learner results")}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <QueryState query={q}>
          {q.data && !q.data.length && (
            <EmptyState
              title={t("interactive.noResults", "No results yet")}
              description={t("interactive.noResultsHint", "Results appear when learners complete the content.")}
            />
          )}
          {q.data && q.data.length > 0 && (
            <div className="overflow-x-auto">
              <Table aria-labelledby="interactive-results">
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("interactive.learner", "Learner")}</TableHead>
                    <TableHead className="text-right">{t("interactive.attemptsHeader", "Attempts")}</TableHead>
                    <TableHead className="text-right">{t("interactive.best", "Best")}</TableHead>
                    <TableHead>{t("common.status", "Status")}</TableHead>
                    <TableHead>{t("interactive.lastAttempt", "Last attempt")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {q.data.map((r) => (
                    <TableRow key={r.user.id}>
                      <TableCell className="font-medium">{fullName(r.user)}</TableCell>
                      <TableCell className="text-right">{r.attempts}</TableCell>
                      <TableCell className="text-right">{r.bestPercent === null ? "—" : `${r.bestPercent}%`}</TableCell>
                      <TableCell>
                        {r.completed ? (
                          <Badge>{t("interactive.completed", "Completed")}</Badge>
                        ) : (
                          <Badge variant="outline">{t("interactive.inProgress", "In progress")}</Badge>
                        )}
                      </TableCell>
                      <TableCell>{fmt.date(r.lastAttemptAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </QueryState>
      </CardContent>
    </Card>
  );
}

function View({ activity }: ActivityViewProps) {
  const s = (activity.settings ?? {}) as Partial<InteractiveSettings>;
  const canView = activity.capabilities["interactive:view"] === true;
  const canResults = activity.capabilities["interactive:view_results"] === true;
  const t = useT();
  return (
    <div className="space-y-4">
      {!canView && (
        <p className="text-sm text-muted-foreground">{t("interactive.noAccess", "You do not have access to this content.")}</p>
      )}
      {canView && s.kind === "embed" && s.embedUrl && <EmbedFrame src={s.embedUrl} title={activity.name} />}
      {canView && s.kind === "h5p" && s.h5p && <H5pPlayer activityId={activity.id} title={s.h5p.title || activity.name} canRecord={!canResults} />}
      {canView && s.kind === "h5p" && !s.h5p && (
        <p className="text-sm text-muted-foreground">{t("interactive.noPackage", "No H5P package has been uploaded.")}</p>
      )}
      {canView && s.kind === "h5p" && !canResults && <MyResultsCard activityId={activity.id} />}
      {canResults && s.kind === "h5p" && <ResultsTable activityId={activity.id} />}
    </div>
  );
}

// ─── Settings ───────────────────────────────────────────────────────────────

function H5pUpload({ value, onChange, labelledBy }: { value: string | null; onChange: (id: string, name: string) => void; labelledBy?: string }) {
  const t = useT();
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState<string | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-labelledby={labelledBy}>
      <input
        ref={ref}
        type="file"
        accept=".h5p"
        className="hidden"
        onChange={async (e) => {
          const picked = e.target.files?.[0];
          e.target.value = "";
          if (!picked) return;
          if (!/\.h5p$/i.test(picked.name)) {
            toast.error(t("interactive.chooseH5p", "Choose an .h5p file"));
            return;
          }
          setBusy(true);
          try {
            // Browsers rarely know the .h5p MIME type; it is a ZIP archive.
            const file = new File([picked], picked.name, { type: "application/zip" });
            const uploaded = await uploadFile(file);
            setName(uploaded.filename);
            onChange(uploaded.id, uploaded.filename);
          } catch (err) {
            toast.error(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      />
      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => ref.current?.click()}>
        <Paperclip aria-hidden />{" "}
        {busy
          ? t("interactive.uploading", "Uploading…")
          : value
            ? t("interactive.replacePackage", "Replace package")
            : t("interactive.uploadPackage", "Upload .h5p package")}
      </Button>
      <span className="text-sm text-muted-foreground" role="status">
        {name}
      </span>
    </div>
  );
}

function SettingsFields({ value, onChange }: SettingsFieldsProps) {
  const kind = (value.kind as "h5p" | "embed") ?? "embed";
  const url = (value.embedUrl as string | null) ?? "";
  const normalized = url.trim() ? normalizeEmbedUrl(url) : null;
  const h5p = value.h5p as InteractiveSettings["h5p"] | undefined;
  const t = useT();
  return (
    <div className="space-y-4">
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("interactive.contentType", "Content type")}</legend>
        <div className="flex flex-wrap gap-4">
          {(
            [
              ["embed", "interactive.kind.embed", "Embed (YouTube, Vimeo, H5P.com, Google, Loom)"],
              ["h5p", "interactive.kind.h5p", "Upload an H5P package"],
            ] as const
          ).map(([k, key, label]) => (
            <label key={k} className="flex items-center gap-2 text-sm">
              <input type="radio" name="interactive-kind" value={k} checked={kind === k} onChange={() => onChange({ ...value, kind: k })} />
              {t(key, label)}
            </label>
          ))}
        </div>
      </fieldset>

      {kind === "embed" ? (
        <div className="space-y-1.5">
          <Label htmlFor="embed-url">{t("interactive.shareLink", "Share link")}</Label>
          <Input
            id="embed-url"
            type="url"
            placeholder="https://www.youtube.com/watch?v=…"
            value={url}
            aria-invalid={(url.trim() !== "" && !normalized) || undefined}
            aria-describedby="embed-url-help"
            onChange={(e) => onChange({ ...value, embedUrl: e.target.value })}
          />
          <p id="embed-url-help" className={url.trim() && !normalized ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
            {url.trim() && !normalized
              ? t("interactive.unsupportedLink", "This link is not supported. Use YouTube, Vimeo, H5P.com, Google Docs/Slides/Sheets/Forms or Loom.")
              : normalized
                ? t("interactive.willEmbed", "Will embed: {url}", { url: normalized.url })
                : t("interactive.shareLinkHint", "Paste the normal share link; it is converted to an embed automatically.")}
          </p>
        </div>
      ) : (
        <div className="space-y-1.5">
          <Label id="h5p-package-label">
            {t("interactive.h5pPackage", "H5P package")}
          </Label>
          <H5pUpload
            labelledBy="h5p-package-label"
            value={(value.packageFileId as string | null) ?? null}
            onChange={(id) => onChange({ ...value, packageFileId: id })}
          />
          {h5p && (
            <p className="text-xs text-muted-foreground">
              {t("interactive.currentPackage", "Current: {title} ({library})", { title: h5p.title, library: h5p.mainLibrary })}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            {t("interactive.sandboxHint", "Packages run in an isolated sandbox. Scores are reported to the gradebook automatically.")}
          </p>
        </div>
      )}

      <div className="space-y-1.5 sm:max-w-48">
        <Label htmlFor="interactive-grade">{t("interactive.maxGrade", "Maximum grade")}</Label>
        <Input
          id="interactive-grade"
          type="number"
          min={0}
          max={10000}
          step="any"
          value={String(value.gradeMax ?? 100)}
          onChange={(e) => onChange({ ...value, gradeMax: e.target.value === "" ? 0 : Number(e.target.value) })}
        />
      </div>
    </div>
  );
}

export const interactiveActivity: ActivityTypeUI = {
  type: "interactive",
  label: "Interactive content",
  description: "H5P packages and embeds",
  icon: Sparkles,
  defaults: { kind: "embed", embedUrl: "", gradeMax: 100 },
  defaultCompletion: "view",
  View,
  SettingsFields,
};
