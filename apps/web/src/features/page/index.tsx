"use client";

import { FileText } from "lucide-react";
import { HtmlContent } from "@/components/common";
import { RichTextEditor } from "@/components/rich-text-editor";
import { Label } from "@/components/ui/label";
import { useT } from "@/lib/i18n";
import type { ActivityTypeUI } from "../activities/types";

function View({ activity }: { activity: { settings: Record<string, unknown> | null } }) {
  const t = useT();
  const html = (activity.settings?.content as string | undefined) ?? "";
  if (!html.trim()) return <p className="text-sm text-muted-foreground">{t("resource.page.empty", "This page has no content yet.")}</p>;
  return (
    <article className="rounded-xl border bg-card p-4 sm:p-6">
      <HtmlContent html={html} className="prose-base" />
    </article>
  );
}

function SettingsFields({ value, onChange }: { value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void }) {
  const t = useT();
  const content = (value.content as string | undefined) ?? "";
  return (
    <div className="space-y-2">
      <Label htmlFor="page-content">{t("resource.page.content", "Page content")}</Label>
      <RichTextEditor id="page-content" value={content} onChange={(html) => onChange({ ...value, content: html })} minHeight={320} />
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
