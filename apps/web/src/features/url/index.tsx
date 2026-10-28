"use client";

import { ExternalLink, Link as LinkIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { ActivityTypeUI, ActivityViewProps, SettingsFieldsProps } from "../activities/types";

/** http(s) only; mirrors the API check (javascript:, data: etc. are rejected). */
export function safeHttpUrl(v: string | null | undefined) {
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

function View({ activity }: ActivityViewProps) {
  const url = safeHttpUrl(activity.settings?.externalUrl as string | undefined);
  const newTab = activity.settings?.openInNewTab !== false;
  if (!url) return <p className="text-sm text-muted-foreground">No link has been set.</p>;
  const host = new URL(url).hostname;
  return (
    <Card>
      <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary" aria-hidden>
            <LinkIcon className="size-5" />
          </span>
          <div className="min-w-0">
            <p className="font-medium">{host}</p>
            <p className="truncate text-sm text-muted-foreground" title={url}>
              {url}
            </p>
          </div>
        </div>
        <Button render={<a href={url} target={newTab ? "_blank" : undefined} rel="noopener noreferrer nofollow" />}>
          Open link <ExternalLink />
          {newTab && <span className="sr-only">(opens in a new tab)</span>}
        </Button>
      </CardContent>
    </Card>
  );
}

function SettingsFields({ value, onChange }: SettingsFieldsProps) {
  const url = (value.externalUrl as string | undefined) ?? "";
  const invalid = url.trim() !== "" && !safeHttpUrl(url.trim());
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="url-external">URL</Label>
        <Input
          id="url-external"
          type="url"
          inputMode="url"
          required
          placeholder="https://example.com"
          value={url}
          aria-invalid={invalid || undefined}
          aria-describedby="url-external-help"
          onChange={(e) => onChange({ ...value, externalUrl: e.target.value })}
        />
        <p id="url-external-help" className={invalid ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
          {invalid ? "Enter a full http:// or https:// address." : "Only http and https links are allowed."}
        </p>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <Switch checked={value.openInNewTab !== false} onCheckedChange={(c) => onChange({ ...value, openInNewTab: c })} /> Open in a new tab
      </label>
    </div>
  );
}

export const urlActivity: ActivityTypeUI = {
  type: "url",
  label: "Link",
  description: "A link to an external website",
  icon: LinkIcon,
  defaults: { externalUrl: "", openInNewTab: true },
  defaultCompletion: "view",
  View,
  SettingsFields,
};
