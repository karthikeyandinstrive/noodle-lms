"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, Pencil, Plus, RotateCw, Settings2, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyState, ErrorAlert, PageHeader, QueryState } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, errorMessage } from "@/lib/api";
import { useFormat, useT } from "@/lib/i18n";
import { ConfirmDialog, Field, RequireCapability } from "../admin/shared";

type Tool = {
  id: string;
  name: string;
  description: string | null;
  clientId: string;
  deploymentId: string;
  loginUrl: string;
  launchUrl: string;
  deepLinkingUrl: string | null;
  jwksUrl: string;
  redirectUris: string[];
  scopes: string[];
  sharePersonalData: boolean;
  enabled: boolean;
  createdAt: string;
};

type ToolConfig = {
  issuer: string;
  clientId: string;
  deploymentId: string;
  authLoginUrl: string;
  accessTokenUrl: string;
  jwksUrl: string;
  redirectUris: string[];
  scopes: string[];
};

type PlatformKey = { kid: string; active: boolean; createdAt: string };

const AGS = [
  "https://purl.imsglobal.org/spec/lti-ags/scope/lineitem",
  "https://purl.imsglobal.org/spec/lti-ags/scope/lineitem.readonly",
  "https://purl.imsglobal.org/spec/lti-ags/scope/score",
  "https://purl.imsglobal.org/spec/lti-ags/scope/result.readonly",
];
const AGS_SCORE = "https://purl.imsglobal.org/spec/lti-ags/scope/score";
const NRPS = ["https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly"];

const toolsKey = ["admin", "lti", "tools"] as const;
const keysKey = ["admin", "lti", "keys"] as const;

type Form = {
  name: string;
  description: string;
  loginUrl: string;
  launchUrl: string;
  deepLinkingUrl: string;
  jwksUrl: string;
  redirectUris: string;
  ags: boolean;
  nrps: boolean;
  sharePersonalData: boolean;
  enabled: boolean;
};

const toForm = (t?: Tool): Form => ({
  name: t?.name ?? "",
  description: t?.description ?? "",
  loginUrl: t?.loginUrl ?? "",
  launchUrl: t?.launchUrl ?? "",
  deepLinkingUrl: t?.deepLinkingUrl ?? "",
  jwksUrl: t?.jwksUrl ?? "",
  redirectUris: (t?.redirectUris ?? []).join("\n"),
  ags: t ? t.scopes.includes(AGS_SCORE) : true,
  nrps: t ? NRPS.every((s) => t.scopes.includes(s)) : true,
  sharePersonalData: t?.sharePersonalData ?? true,
  enabled: t?.enabled ?? true,
});

function CopyValue({ label, value }: { label: string; value: string }) {
  const t = useT();
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="flex items-center gap-1">
        <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1 text-xs" title={value}>
          {value}
        </code>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("lti.admin.copy", "Copy {label}", { label })}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              toast.success(t("lti.admin.copied", "Copied"));
            } catch {
              toast.error(t("lti.admin.copyFailed", "Could not copy to the clipboard"));
            }
          }}
        >
          <Copy />
        </Button>
      </div>
    </div>
  );
}

function ToolConfigPanel({ toolId }: { toolId: string }) {
  const t = useT();
  const q = useQuery({ queryKey: [...toolsKey, toolId, "config"], queryFn: () => api<ToolConfig>(`/lti/tools/${toolId}/config`) });
  return (
    <QueryState query={q}>
      {q.data && (
        <div className="grid gap-3 sm:grid-cols-2">
          <CopyValue label={t("lti.admin.issuer", "Issuer (platform ID)")} value={q.data.issuer} />
          <CopyValue label={t("lti.admin.clientId", "Client ID")} value={q.data.clientId} />
          <CopyValue label={t("lti.admin.deploymentId", "Deployment ID")} value={q.data.deploymentId} />
          <CopyValue label={t("lti.admin.authUrl", "Authorization (OIDC auth) URL")} value={q.data.authLoginUrl} />
          <CopyValue label={t("lti.admin.tokenUrl", "Access token URL")} value={q.data.accessTokenUrl} />
          <CopyValue label={t("lti.admin.jwksUrl", "Public keyset (JWKS) URL")} value={q.data.jwksUrl} />
        </div>
      )}
    </QueryState>
  );
}

function ToolForm({ tool, courseId, onDone }: { tool?: Tool; courseId?: string; onDone: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [v, setV] = useState<Form>(() => toForm(tool));
  const set = <K extends keyof Form>(k: K, value: Form[K]) => setV((p) => ({ ...p, [k]: value }));
  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: v.name.trim(),
        description: v.description.trim() || null,
        loginUrl: v.loginUrl.trim(),
        launchUrl: v.launchUrl.trim(),
        deepLinkingUrl: v.deepLinkingUrl.trim() || null,
        jwksUrl: v.jwksUrl.trim(),
        redirectUris: v.redirectUris
          .split(/\s+/)
          .map((s) => s.trim())
          .filter(Boolean),
        scopes: [...(v.ags ? AGS : []), ...(v.nrps ? NRPS : [])],
        sharePersonalData: v.sharePersonalData,
        enabled: v.enabled,
      };
      return tool ? api<Tool>(`/lti/tools/${tool.id}`, { method: "PATCH", body }) : api<Tool>("/lti/tools", { body: { ...body, courseId: courseId ?? null } });
    },
    onSuccess: () => {
      toast.success(tool ? t("lti.admin.saved", "Tool saved") : t("lti.admin.created", "Tool registered. Copy the platform details into the tool."));
      void qc.invalidateQueries({ queryKey: toolsKey });
      onDone();
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{tool ? t("lti.admin.editTool", "Edit {name}", { name: tool.name }) : t("lti.admin.newTool", "Register an LTI 1.3 tool")}</CardTitle>
        <CardDescription>{t("lti.admin.formHelp", "Enter the details from the tool provider. Client and deployment IDs are generated for you.")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          {save.error ? <ErrorAlert error={save.error} /> : null}
          <Field id="lti-name" label={t("lti.admin.name", "Name")}>
            <Input id="lti-name" required maxLength={255} value={v.name} onChange={(e) => set("name", e.target.value)} />
          </Field>
          <Field id="lti-desc" label={t("lti.admin.description", "Description")}>
            <Input id="lti-desc" maxLength={2000} value={v.description} onChange={(e) => set("description", e.target.value)} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="lti-login" label={t("lti.admin.loginUrl", "OIDC login initiation URL")}>
              <Input id="lti-login" type="url" required value={v.loginUrl} onChange={(e) => set("loginUrl", e.target.value)} />
            </Field>
            <Field id="lti-launch" label={t("lti.admin.launchUrl", "Launch (target link) URL")}>
              <Input id="lti-launch" type="url" required value={v.launchUrl} onChange={(e) => set("launchUrl", e.target.value)} />
            </Field>
          </div>
          <Field id="lti-deeplink" label={t("lti.admin.deepLinkingUrl", "Deep Linking URL (optional)")} hint={t("lti.admin.deepLinkingHint", "Where teachers choose content in the tool. Defaults to the launch URL.")}>
            <Input id="lti-deeplink" type="url" value={v.deepLinkingUrl} onChange={(e) => set("deepLinkingUrl", e.target.value)} />
          </Field>
          <Field id="lti-jwks" label={t("lti.admin.toolJwks", "Tool public keyset (JWKS) URL")}>
            <Input id="lti-jwks" type="url" required value={v.jwksUrl} onChange={(e) => set("jwksUrl", e.target.value)} />
          </Field>
          <Field id="lti-redirects" label={t("lti.admin.redirectUris", "Redirect URIs")} hint={t("lti.admin.redirectHint", "One per line. Defaults to the launch URL.")}>
            <Textarea id="lti-redirects" rows={3} className="font-mono text-xs" value={v.redirectUris} onChange={(e) => set("redirectUris", e.target.value)} />
          </Field>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t("lti.admin.services", "Services")}</legend>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={v.ags} onCheckedChange={(c) => set("ags", c)} /> {t("lti.admin.ags", "Assignment and Grade Services (send grades)")}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={v.nrps} onCheckedChange={(c) => set("nrps", c)} /> {t("lti.admin.nrps", "Names and Role Provisioning (course roster)")}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={v.sharePersonalData} onCheckedChange={(c) => set("sharePersonalData", c)} />{" "}
              {t("lti.admin.sharePersonal", "Share learners' names and email addresses")}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={v.enabled} onCheckedChange={(c) => set("enabled", c)} /> {t("lti.admin.enabled", "Enabled")}
            </label>
          </fieldset>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? t("common.saving", "Saving…") : tool ? t("common.save", "Save") : t("lti.admin.register", "Register tool")}
            </Button>
            <Button type="button" variant="ghost" onClick={onDone}>
              {t("common.cancel", "Cancel")}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function ToolCard({ tool, onEdit }: { tool: Tool; onEdit: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [showConfig, setShowConfig] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api(`/lti/tools/${tool.id}`, { method: "PATCH", body: { enabled } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: toolsKey }),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: () => api(`/lti/tools/${tool.id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(t("lti.admin.deleted", "Tool deleted"));
      setConfirmDelete(false);
      void qc.invalidateQueries({ queryKey: toolsKey });
    },
    onError: (e) => {
      setConfirmDelete(false);
      toast.error(errorMessage(e));
    },
  });

  return (
    <Card size="sm">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="flex flex-wrap items-center gap-2">
              {tool.name}
              {tool.enabled ? <Badge>{t("lti.admin.enabled", "Enabled")}</Badge> : <Badge variant="outline">{t("lti.admin.disabled", "Disabled")}</Badge>}
            </CardTitle>
            {tool.description && <CardDescription>{tool.description}</CardDescription>}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <label className="mr-2 flex items-center gap-2 text-xs text-muted-foreground">
              <Switch checked={tool.enabled} disabled={toggle.isPending} onCheckedChange={(c) => toggle.mutate(c)} aria-label={t("lti.admin.enabled", "Enabled")} />
            </label>
            <Button variant="outline" size="sm" onClick={() => setShowConfig((s) => !s)} aria-expanded={showConfig}>
              <Settings2 aria-hidden /> {t("lti.admin.platformDetails", "Platform details")}
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label={t("lti.admin.edit", "Edit {name}", { name: tool.name })} onClick={onEdit}>
              <Pencil />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label={t("lti.admin.delete", "Delete {name}", { name: tool.name })} onClick={() => setConfirmDelete(true)}>
              <Trash2 />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
          <span className="truncate">
            {t("lti.admin.loginUrlShort", "Login URL")}: {tool.loginUrl}
          </span>
          <span className="truncate">
            {t("lti.admin.launchUrlShort", "Launch URL")}: {tool.launchUrl}
          </span>
        </div>
        {showConfig && <ToolConfigPanel toolId={tool.id} />}
      </CardContent>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t("lti.admin.deleteTitle", "Delete this tool?")}
        description={t("lti.admin.deleteHelp", "Tools used by activities cannot be deleted; disable them instead.")}
        destructive
        confirmLabel={t("common.delete", "Delete")}
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </Card>
  );
}

function KeysCard() {
  const t = useT();
  const fmt = useFormat();
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const keys = useQuery({ queryKey: keysKey, queryFn: () => api<PlatformKey[]>("/lti/keys") });
  const rotate = useMutation({
    mutationFn: () => api<{ kid: string }>("/lti/keys/rotate", { body: {} }),
    onSuccess: () => {
      toast.success(t("lti.admin.rotated", "New signing key created"));
      setConfirm(false);
      void qc.invalidateQueries({ queryKey: keysKey });
    },
    onError: (e) => {
      setConfirm(false);
      toast.error(errorMessage(e));
    },
  });
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2">
              <KeyRound aria-hidden className="size-4" /> {t("lti.admin.keys", "Platform signing keys")}
            </CardTitle>
            <CardDescription>{t("lti.admin.keysHelp", "Launches are signed with the active key. Previous keys stay in the public keyset for 7 days after rotation.")}</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => setConfirm(true)}>
            <RotateCw aria-hidden /> {t("lti.admin.rotate", "Rotate key")}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <QueryState query={keys}>
          {keys.data && keys.data.length === 0 && <p className="text-sm text-muted-foreground">{t("lti.admin.noKeys", "A key is created automatically on the first launch.")}</p>}
          {keys.data && keys.data.length > 0 && (
            <ul className="space-y-1 text-sm">
              {keys.data.map((k) => (
                <li key={k.kid} className="flex flex-wrap items-center gap-2">
                  <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{k.kid}</code>
                  {k.active ? <Badge>{t("lti.admin.active", "Active")}</Badge> : <Badge variant="outline">{t("lti.admin.retired", "Retired")}</Badge>}
                  <span className="text-xs text-muted-foreground">{fmt.date(k.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </QueryState>
      </CardContent>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t("lti.admin.rotateTitle", "Rotate the signing key?")}
        description={t("lti.admin.rotateHelp", "Tools that cache our keyset will pick up the new key automatically. The old key remains valid for 7 days.")}
        confirmLabel={t("lti.admin.rotate", "Rotate key")}
        pending={rotate.isPending}
        onConfirm={() => rotate.mutate()}
      />
    </Card>
  );
}

/** Tool list with add/edit: the organization's tools, or one course's own tools. */
function ToolList({ courseId, editing, setEditing }: { courseId?: string; editing: Tool | "new" | null; setEditing: (v: Tool | "new" | null) => void }) {
  const t = useT();
  const tools = useQuery({
    queryKey: [...toolsKey, courseId ?? "organization"],
    queryFn: () => api<Tool[]>(courseId ? `/lti/tools?courseId=${courseId}` : "/lti/tools"),
  });
  return (
    <>
      {editing !== null && (
        <ToolForm key={editing === "new" ? "new" : editing.id} tool={editing === "new" ? undefined : editing} courseId={courseId} onDone={() => setEditing(null)} />
      )}
      <QueryState query={tools}>
        {tools.data && tools.data.length === 0 && editing === null && (
          <EmptyState title={t("lti.admin.empty", "No tools yet")} description={t("lti.admin.emptyHelp", "Register a tool to make it available in course activities.")} />
        )}
        {tools.data?.map((tool) => (
          <ToolCard key={tool.id} tool={tool} onEdit={() => setEditing(tool)} />
        ))}
      </QueryState>
    </>
  );
}

export function LtiAdmin() {
  const t = useT();
  const [editing, setEditing] = useState<Tool | "new" | null>(null);

  return (
    <RequireCapability capability="lti:manage_tools">
      <PageHeader
        title={t("lti.admin.title", "External tools (LTI 1.3)")}
        description={t("lti.admin.subtitle", "Register LTI 1.3 / LTI Advantage tools that teachers can add to their courses.")}
        actions={
          editing === null && (
            <Button onClick={() => setEditing("new")}>
              <Plus aria-hidden /> {t("lti.admin.add", "Register tool")}
            </Button>
          )
        }
      />
      <div className="max-w-4xl space-y-4">
        <ToolList editing={editing} setEditing={setEditing} />
        <KeysCard />
      </div>
    </RequireCapability>
  );
}

/** A course's own tools, managed by its teachers (lti:manage_course_tools). */
export function CourseLtiTools({ courseId, canManage }: { courseId: string; canManage: boolean }) {
  const t = useT();
  const [editing, setEditing] = useState<Tool | "new" | null>(null);
  if (!canManage) return <ErrorAlert error={new Error(t("lti.course.forbidden", "You can't manage this course's external tools."))} />;
  return (
    <div className="max-w-4xl space-y-4">
      <PageHeader
        title={t("lti.course.title", "Course external tools")}
        description={t("lti.course.subtitle", "Register LTI 1.3 tools for this course only. Organization-wide tools are managed by administrators.")}
        actions={
          editing === null && (
            <Button onClick={() => setEditing("new")}>
              <Plus aria-hidden /> {t("lti.admin.add", "Register tool")}
            </Button>
          )
        }
      />
      <ToolList courseId={courseId} editing={editing} setEditing={setEditing} />
    </div>
  );
}
