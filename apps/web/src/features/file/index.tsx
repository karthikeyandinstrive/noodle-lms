"use client";

import { Download, FileDown } from "lucide-react";
import { FileInput } from "@/components/file-input";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import type { ActivityTypeUI, ActivityViewProps, SettingsFieldsProps } from "../activities/types";
import { formatBytes, NativeSelectClass } from "../certificate/shared";

type FileSettings = {
  fileId: string | null;
  display: "download" | "inline";
  filename: string | null;
  mimeType: string | null;
  size: number | null;
  inlineSupported: boolean;
};

function View({ activity }: ActivityViewProps) {
  const s = (activity.settings ?? {}) as Partial<FileSettings>;
  if (!s.fileId) return <p className="text-sm text-muted-foreground">No file has been uploaded.</p>;
  const src = `/api/v1/content/${activity.id}/file`;
  const download = `${src}?download=true`;
  const mime = s.mimeType ?? "";
  const inline = s.display === "inline" && s.inlineSupported;
  const name = s.filename ?? "file";

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary" aria-hidden>
              <FileDown className="size-5" />
            </span>
            <div className="min-w-0">
              <p className="truncate font-medium">{name}</p>
              <p className="text-sm text-muted-foreground">
                {mime} {s.size ? `· ${formatBytes(s.size)}` : ""}
              </p>
            </div>
          </div>
          <Button render={<a href={download} download />}>
            <Download /> Download
          </Button>
        </CardContent>
      </Card>
      {inline && mime === "application/pdf" && (
        <iframe src={src} title={name} className="h-[75vh] min-h-96 w-full rounded-xl border bg-white" />
      )}
      {inline && mime.startsWith("image/") && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={activity.name} className="mx-auto max-h-[75vh] max-w-full rounded-xl border object-contain" />
      )}
      {inline && mime.startsWith("video/") && (
        <video src={src} controls preload="metadata" className="w-full rounded-xl border bg-black">
          Your browser cannot play this video. <a href={download}>Download it</a> instead.
        </video>
      )}
      {inline && mime.startsWith("audio/") && <audio src={src} controls preload="metadata" className="w-full" />}
    </div>
  );
}

function SettingsFields({ value, onChange }: SettingsFieldsProps) {
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label>File</Label>
        <FileInput value={(value.fileId as string | null) ?? null} onChange={(fileId) => onChange({ ...value, fileId })} />
        {typeof value.filename === "string" && value.fileId ? <p className="text-xs text-muted-foreground">Current: {value.filename}</p> : null}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="file-display">Display</Label>
        <select
          id="file-display"
          className={NativeSelectClass}
          value={(value.display as string) ?? "inline"}
          onChange={(e) => onChange({ ...value, display: e.target.value })}
        >
          <option value="inline">Show in the page when possible (PDF, images, video, audio)</option>
          <option value="download">Download only</option>
        </select>
      </div>
    </div>
  );
}

export const fileActivity: ActivityTypeUI = {
  type: "file",
  label: "File",
  description: "A downloadable or viewable file",
  icon: FileDown,
  defaults: { fileId: null, display: "inline" },
  defaultCompletion: "view",
  View,
  SettingsFields,
};
