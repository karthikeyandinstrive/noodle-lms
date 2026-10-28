"use client";

import { FileText } from "lucide-react";
import { HtmlContent } from "@/components/common";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ActivityTypeUI } from "../activities/types";

function View({ activity }: { activity: { settings: Record<string, unknown> | null } }) {
  const html = (activity.settings?.content as string | undefined) ?? "";
  if (!html.trim()) return <p className="text-sm text-muted-foreground">This page has no content yet.</p>;
  return (
    <article className="rounded-xl border bg-card p-4 sm:p-6">
      <HtmlContent html={html} className="prose-base" />
    </article>
  );
}

function SettingsFields({ value, onChange }: { value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void }) {
  const content = (value.content as string | undefined) ?? "";
  return (
    <div className="space-y-2">
      <Label htmlFor="page-content">Page content</Label>
      <Textarea
        id="page-content"
        rows={14}
        className="font-mono text-sm"
        aria-describedby="page-content-help"
        value={content}
        onChange={(e) => onChange({ ...value, content: e.target.value })}
      />
      <p id="page-content-help" className="text-xs text-muted-foreground">
        Formatting with HTML is supported (headings, lists, links, images). Unsafe markup such as scripts is removed when you save; view the
        activity to see the result.
      </p>
    </div>
  );
}

export const pageActivity: ActivityTypeUI = {
  type: "page",
  label: "Page",
  description: "A page of formatted content",
  icon: FileText,
  defaults: { content: "" },
  defaultCompletion: "view",
  View,
  SettingsFields,
};
