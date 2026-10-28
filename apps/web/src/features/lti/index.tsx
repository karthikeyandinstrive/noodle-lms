"use client";

import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Plug } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { QueryState } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import type { ActivityTypeUI, ActivityViewProps, SettingsFieldsProps } from "../activities/types";

type LtiSettings = {
  toolId: string;
  toolName: string;
  toolEnabled: boolean;
  targetLinkUri: string | null;
  customParams: Record<string, string>;
  gradeMax: number | null;
  openInNewWindow: boolean;
};

type AvailableTool = { id: string; name: string; description: string | null };

const launchUrl = (activityId: string) => `/api/v1/lti/${activityId}/launch`;

// ─── View ───────────────────────────────────────────────────────────────────

function View({ activity }: ActivityViewProps) {
  const t = useT();
  const s = (activity.settings ?? {}) as Partial<LtiSettings>;
  const canLaunch = activity.capabilities["lti:launch"] === true;
  // Re-mounting the iframe starts a fresh launch (each launch hint is single use).
  const [frameKey, setFrameKey] = useState(0);

  if (!canLaunch) return <p className="text-sm text-muted-foreground">{t("lti.noAccess", "You do not have permission to launch this tool.")}</p>;
  if (s.toolEnabled === false) return <p className="text-sm text-muted-foreground">{t("lti.disabled", "This external tool is currently disabled.")}</p>;

  const openButton = (
    <a href={launchUrl(activity.id)} target="_blank" rel="noopener" className={buttonVariants({ variant: s.openInNewWindow ? "default" : "outline", size: "sm" })}>
      <ExternalLink aria-hidden /> {s.openInNewWindow ? t("lti.launch", "Launch {tool}", { tool: s.toolName ?? "" }) : t("lti.openNewWindow", "Open in new window")}
    </a>
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {s.toolName && (
          <Badge variant="outline" className="gap-1">
            <Plug aria-hidden className="size-3" /> {s.toolName}
          </Badge>
        )}
        {s.gradeMax != null && <Badge variant="secondary">{t("lti.gradedOutOf", "Graded out of {max}", { max: s.gradeMax })}</Badge>}
        <div className="ml-auto flex gap-2">
          {!s.openInNewWindow && (
            <button type="button" className={buttonVariants({ variant: "ghost", size: "sm" })} onClick={() => setFrameKey((k) => k + 1)}>
              {t("lti.relaunch", "Relaunch")}
            </button>
          )}
          {openButton}
        </div>
      </div>
      {s.openInNewWindow ? (
        <p className="text-sm text-muted-foreground">{t("lti.opensInNewWindow", "This tool opens in a new window.")}</p>
      ) : (
        <iframe
          key={frameKey}
          src={launchUrl(activity.id)}
          title={activity.name}
          className="h-[70vh] min-h-[480px] w-full rounded-xl border bg-white"
          allow="fullscreen; clipboard-write; autoplay"
          allowFullScreen
          referrerPolicy="origin"
        />
      )}
    </div>
  );
}

// ─── Settings ───────────────────────────────────────────────────────────────

const CUSTOM_KEY = /^[A-Za-z0-9_.-]{1,100}$/;

function toLines(params: Record<string, string> | undefined) {
  return Object.entries(params ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

function parseLines(text: string): { params: Record<string, string>; error: string | null } {
  const params: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    const key = i > 0 ? line.slice(0, i).trim() : "";
    if (!CUSTOM_KEY.test(key)) return { params, error: line };
    params[key] = line.slice(i + 1).trim();
  }
  return { params, error: null };
}

const noSubscribe = () => () => {};

/**
 * LTI Deep Linking: the teacher picks content inside the tool, which sends back the link
 * (URL, title, custom parameters, maximum grade). The tool returns to this edit page.
 */
function DeepLinkPanel({ activityId, toolId, savedToolId }: { activityId: string; toolId?: string; savedToolId?: string }) {
  const t = useT();
  // Set by the tool's return redirect (?deepLink=selected|cancelled).
  const result = useSyncExternalStore(
    noSubscribe,
    () => new URLSearchParams(window.location.search).get("deepLink"),
    () => null,
  );
  const changed = toolId !== savedToolId;
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{t("lti.deepLinkHelp", "Pick a specific resource (a quiz, a video …) inside the tool. Its link, title and maximum grade are filled in for you.")}</p>
        {changed ? (
          <span className="text-xs text-muted-foreground">{t("lti.deepLinkSaveFirst", "Save the new tool first")}</span>
        ) : (
          <a href={`/api/v1/lti/${activityId}/deep-link`} className={buttonVariants({ variant: "outline", size: "sm" })}>
            {t("lti.deepLink", "Choose content in the tool")}
          </a>
        )}
      </div>
      {result === "selected" && <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">{t("lti.deepLinkSelected", "Content selected. The link below was updated.")}</p>}
      {result === "cancelled" && <p role="status" className="text-sm text-muted-foreground">{t("lti.deepLinkCancelled", "No content was selected.")}</p>}
    </div>
  );
}

function SettingsFields({ value, onChange, activityId, courseId }: SettingsFieldsProps) {
  const t = useT();
  const tools = useQuery({ queryKey: ["lti", "tools", "available", courseId], queryFn: () => api<AvailableTool[]>(`/lti/tools/available?courseId=${courseId}`) });
  const [text, setText] = useState(() => toLines(value.customParams as Record<string, string> | undefined));
  const [badLine, setBadLine] = useState<string | null>(null);
  const gradeMax = value.gradeMax as number | null | undefined;
  const graded = gradeMax !== null && gradeMax !== undefined;
  // Content selection runs against the saved tool; a changed tool must be saved first.
  const [savedToolId] = useState(() => value.toolId as string | undefined);

  return (
    <div className="space-y-4">
      {activityId && <DeepLinkPanel activityId={activityId} toolId={value.toolId as string | undefined} savedToolId={savedToolId} />}
      <div className="space-y-1.5">
        <Label htmlFor="lti-tool">{t("lti.tool", "Tool")}</Label>
        <QueryState query={tools}>
          {tools.data && tools.data.length === 0 && (
            <p className="text-sm text-muted-foreground">{t("lti.noTools", "No external tools are registered yet. An administrator can add them under Site administration → External tools.")}</p>
          )}
          {tools.data && tools.data.length > 0 && (
            <select
              id="lti-tool"
              required
              className="h-8 w-full rounded-lg border bg-background px-2 text-sm"
              value={(value.toolId as string) ?? ""}
              onChange={(e) => onChange({ ...value, toolId: e.target.value })}
            >
              <option value="" disabled>
                {t("lti.chooseTool", "Choose a tool…")}
              </option>
              {tools.data.map((tool) => (
                <option key={tool.id} value={tool.id}>
                  {tool.name}
                </option>
              ))}
            </select>
          )}
        </QueryState>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="lti-target">{t("lti.targetLink", "Launch URL (optional)")}</Label>
        <Input
          id="lti-target"
          type="url"
          placeholder={t("lti.targetLinkPlaceholder", "Uses the tool's default launch URL")}
          value={(value.targetLinkUri as string | null) ?? ""}
          onChange={(e) => onChange({ ...value, targetLinkUri: e.target.value.trim() ? e.target.value : null })}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="lti-custom">{t("lti.customParams", "Custom parameters")}</Label>
        <Textarea
          id="lti-custom"
          rows={4}
          className="font-mono text-xs"
          placeholder={"level=3\nuser=$User.id"}
          value={text}
          aria-invalid={badLine ? true : undefined}
          aria-describedby="lti-custom-help"
          onChange={(e) => {
            setText(e.target.value);
            const parsed = parseLines(e.target.value);
            setBadLine(parsed.error);
            if (!parsed.error) onChange({ ...value, customParams: parsed.params });
          }}
        />
        <p id="lti-custom-help" className={badLine ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
          {badLine
            ? t("lti.customParamsError", "Invalid line: {line}. Use key=value with letters, digits, '_', '.' or '-' in the key.", { line: badLine.slice(0, 60) })
            : t("lti.customParamsHelp", "One key=value per line. Supported variables: $User.id, $Context.id, $ResourceLink.id, $ResourceLink.title.")}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={graded} onCheckedChange={(c) => onChange({ ...value, gradeMax: c ? 100 : null })} />
          {t("lti.graded", "The tool sends grades")}
        </label>
        {graded && (
          <div className="space-y-1.5">
            <Label htmlFor="lti-grade">{t("lti.gradeMax", "Maximum grade")}</Label>
            <Input
              id="lti-grade"
              type="number"
              min={0.01}
              max={10000}
              step="any"
              value={String(gradeMax)}
              onChange={(e) => onChange({ ...value, gradeMax: e.target.value === "" ? 100 : Number(e.target.value) })}
            />
          </div>
        )}
      </div>

      <label className="flex items-center gap-2 text-sm">
        <Switch checked={value.openInNewWindow === true} onCheckedChange={(c) => onChange({ ...value, openInNewWindow: c })} />
        {t("lti.newWindow", "Open in a new window instead of embedding")}
      </label>
    </div>
  );
}

export const ltiActivity: ActivityTypeUI = {
  type: "lti",
  label: "External tool",
  description: "An LTI 1.3 tool from another provider",
  icon: Plug,
  defaults: { toolId: "", customParams: {}, gradeMax: null, openInNewWindow: false },
  defaultCompletion: "view",
  View,
  SettingsFields,
};
