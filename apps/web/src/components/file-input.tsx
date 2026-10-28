"use client";

import { Paperclip, X } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { errorMessage, fileUrl, uploadFile, type UploadedFile } from "@/lib/api";

/** Single-file picker that uploads immediately and reports the file id. */
export function FileInput({
  value,
  onChange,
  accept,
  component,
  area,
}: {
  value: string | null;
  onChange: (fileId: string | null, file?: UploadedFile) => void;
  accept?: string;
  component?: string;
  area?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <div className="flex items-center gap-2">
      <input
        ref={ref}
        type="file"
        accept={accept}
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          setBusy(true);
          try {
            const uploaded = await uploadFile(file, { component, area });
            setName(uploaded.filename);
            onChange(uploaded.id, uploaded);
          } catch (err) {
            toast.error(errorMessage(err));
          } finally {
            setBusy(false);
            e.target.value = "";
          }
        }}
      />
      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => ref.current?.click()}>
        <Paperclip /> {busy ? "Uploading…" : value ? "Replace file" : "Choose file"}
      </Button>
      {value && (
        <>
          <a href={fileUrl(value)} className="max-w-48 truncate text-sm text-primary hover:underline" target="_blank" rel="noreferrer">
            {name ?? "Current file"}
          </a>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove file" onClick={() => onChange(null)}>
            <X />
          </Button>
        </>
      )}
    </div>
  );
}

/** Multi-file uploader used by submissions. */
export function MultiFileInput({
  files,
  onChange,
  maxFiles = 10,
  accept,
}: {
  files: UploadedFile[];
  onChange: (files: UploadedFile[]) => void;
  maxFiles?: number;
  accept?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-2">
      <input
        ref={ref}
        type="file"
        multiple
        accept={accept}
        className="hidden"
        onChange={async (e) => {
          const picked = Array.from(e.target.files ?? []).slice(0, maxFiles - files.length);
          setBusy(true);
          try {
            const uploaded: UploadedFile[] = [];
            for (const f of picked) uploaded.push(await uploadFile(f));
            onChange([...files, ...uploaded]);
          } catch (err) {
            toast.error(errorMessage(err));
          } finally {
            setBusy(false);
            e.target.value = "";
          }
        }}
      />
      <ul className="space-y-1">
        {files.map((f) => (
          <li key={f.id} className="flex items-center gap-2 text-sm">
            <Paperclip className="size-3.5 text-muted-foreground" />
            <span className="truncate">{f.filename}</span>
            <Button type="button" variant="ghost" size="icon-xs" aria-label={`Remove ${f.filename}`} onClick={() => onChange(files.filter((x) => x.id !== f.id))}>
              <X />
            </Button>
          </li>
        ))}
      </ul>
      <Button type="button" variant="outline" size="sm" disabled={busy || files.length >= maxFiles} onClick={() => ref.current?.click()}>
        <Paperclip /> {busy ? "Uploading…" : "Add files"}
      </Button>
    </div>
  );
}
