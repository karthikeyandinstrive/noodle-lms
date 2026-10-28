"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, PlugZap, XCircle } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ErrorAlert, PageHeader, QueryState } from "@/components/common";
import { api, errorMessage } from "@/lib/api";
import { Field, NativeSelect, RequireCapability } from "./shared";
import type { StorageConfig } from "./types";

const storageKey = ["admin", "storage"] as const;
type Provider = "s3" | "minio" | "r2";

const PROVIDERS: Record<Provider, { label: string; endpointHint: string; regionHint: string }> = {
  s3: { label: "Amazon S3", endpointHint: "Leave blank for AWS.", regionHint: "e.g. eu-west-1 (required)" },
  minio: { label: "MinIO (self-hosted)", endpointHint: "e.g. https://minio.example.com (required)", regionHint: "Usually us-east-1" },
  r2: { label: "Cloudflare R2", endpointHint: "https://<account-id>.r2.cloudflarestorage.com (required)", regionHint: "Use auto" },
};

type Form = { provider: Provider; enabled: boolean; endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string; publicUrl: string };

function toForm(c: StorageConfig | null): Form {
  return {
    provider: c && c.provider !== "local" ? c.provider : "s3",
    enabled: c?.enabled ?? false,
    endpoint: c?.endpoint ?? "",
    region: c?.region ?? "",
    bucket: c?.bucket ?? "",
    accessKeyId: c?.accessKeyId ?? "",
    secretAccessKey: "",
    publicUrl: c?.publicUrl ?? "",
  };
}

function StorageForm({ current }: { current: StorageConfig | null }) {
  const qc = useQueryClient();
  const [v, setV] = useState<Form>(() => toForm(current));
  const [error, setError] = useState<unknown>(null);
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const set = <K extends keyof Form>(k: K, value: Form[K]) => {
    setV((p) => ({ ...p, [k]: value }));
    setTest(null);
  };
  const payload = () => ({
    provider: v.provider,
    endpoint: v.endpoint.trim() || null,
    region: v.region.trim() || null,
    bucket: v.bucket.trim(),
    accessKeyId: v.accessKeyId.trim(),
    secretAccessKey: v.secretAccessKey || undefined,
    publicUrl: v.publicUrl.trim() || null,
  });

  const save = useMutation({
    mutationFn: () => api("/storage/config", { body: { ...payload(), enabled: v.enabled } }),
    onSuccess: () => {
      toast.success("Storage settings saved");
      void qc.invalidateQueries({ queryKey: storageKey });
    },
    onError: setError,
  });
  const runTest = useMutation({
    mutationFn: () => api<{ ok: boolean; message: string }>("/storage/test", { body: payload() }),
    onSuccess: setTest,
    onError: (e) => setTest({ ok: false, message: errorMessage(e) }),
  });
  const meta = PROVIDERS[v.provider];

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        save.mutate();
      }}
    >
      {error ? <ErrorAlert error={error} /> : null}
      <Card>
        <CardHeader>
          <CardTitle>Object storage</CardTitle>
          <CardDescription>
            Files are stored on the server&apos;s default storage until an external bucket is enabled here. Only new uploads use the new bucket.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field id="st-provider" label="Provider">
            <NativeSelect id="st-provider" value={v.provider} onChange={(e) => set("provider", e.target.value as Provider)}>
              {(Object.keys(PROVIDERS) as Provider[]).map((p) => (
                <option key={p} value={p}>
                  {PROVIDERS[p].label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="st-endpoint" label="Endpoint" hint={meta.endpointHint}>
              <Input id="st-endpoint" type="url" required={v.provider !== "s3"} value={v.endpoint} onChange={(e) => set("endpoint", e.target.value)} />
            </Field>
            <Field id="st-region" label="Region" hint={meta.regionHint}>
              <Input id="st-region" required={v.provider === "s3"} maxLength={50} value={v.region} onChange={(e) => set("region", e.target.value)} />
            </Field>
          </div>
          <Field id="st-bucket" label="Bucket">
            <Input id="st-bucket" required minLength={3} maxLength={63} value={v.bucket} onChange={(e) => set("bucket", e.target.value)} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="st-key" label="Access key ID">
              <Input id="st-key" required autoComplete="off" maxLength={200} value={v.accessKeyId} onChange={(e) => set("accessKeyId", e.target.value)} />
            </Field>
            <Field id="st-secret" label="Secret access key" hint={current ? `Stored: ${current.secretAccessKey}. Leave blank to keep it.` : undefined}>
              <Input
                id="st-secret"
                type="password"
                autoComplete="new-password"
                required={!current}
                maxLength={200}
                placeholder={current ? current.secretAccessKey : ""}
                value={v.secretAccessKey}
                onChange={(e) => set("secretAccessKey", e.target.value)}
              />
            </Field>
          </div>
          <Field id="st-public" label="Public URL" hint="Optional CDN or public bucket URL.">
            <Input id="st-public" type="url" value={v.publicUrl} onChange={(e) => set("publicUrl", e.target.value)} />
          </Field>
          <label className="flex items-start gap-3 text-sm">
            <Switch checked={v.enabled} onCheckedChange={(c) => set("enabled", c)} className="mt-0.5" />
            <span>
              <span className="font-medium">Use this bucket for new uploads</span>
              <span className="block text-muted-foreground">Test the connection before enabling.</span>
            </span>
          </label>
          {test && (
            <Alert variant={test.ok ? "default" : "destructive"} aria-live="polite">
              {test.ok ? <CheckCircle2 /> : <XCircle />}
              <AlertTitle>{test.ok ? "Connection succeeded" : "Connection failed"}</AlertTitle>
              <AlertDescription>{test.message}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={runTest.isPending || !v.bucket || !v.accessKeyId} onClick={() => runTest.mutate()}>
          <PlugZap /> {runTest.isPending ? "Testing…" : "Test connection"}
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}

export function StorageAdmin() {
  const cfg = useQuery({ queryKey: storageKey, queryFn: () => api<StorageConfig | null>("/storage/config") });
  return (
    <RequireCapability capability="storage:manage">
      <PageHeader title="File storage" description="Store course files in your own S3-compatible bucket." />
      <div className="max-w-3xl">
        <QueryState query={cfg}>{cfg.isSuccess && <StorageForm key={JSON.stringify(cfg.data)} current={cfg.data ?? null} />}</QueryState>
      </div>
    </RequireCapability>
  );
}
