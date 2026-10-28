"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Pencil, PlugZap, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyState, ErrorAlert, PageHeader, QueryState } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog, Field, NativeSelect, RequireCapability } from "@/features/admin/shared";
import { api, errorMessage } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useSession } from "@/lib/session";
import type { SsoProvider, SsoType } from "./types";

const providersKey = ["admin", "sso", "providers"] as const;
const orgKey = ["admin", "organization"] as const;

type Form = {
  type: SsoType;
  slug: string;
  name: string;
  enabled: boolean;
  enforced: boolean;
  autoProvision: boolean;
  allowedDomains: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  entryPoint: string;
  idpIssuer: string;
  idpCert: string;
  spEntityId: string;
};

function toForm(p: SsoProvider | null): Form {
  return {
    type: p?.type ?? "oidc",
    slug: p?.slug ?? "",
    name: p?.name ?? "",
    enabled: p?.enabled ?? false,
    enforced: p?.enforced ?? false,
    autoProvision: p?.autoProvision ?? false,
    allowedDomains: p?.allowedDomains.join("\n") ?? "",
    issuer: p?.oidc?.issuer ?? "",
    clientId: p?.oidc?.clientId ?? "",
    clientSecret: "",
    scopes: p?.oidc?.scopes ?? "",
    entryPoint: p?.saml?.entryPoint ?? "",
    idpIssuer: p?.saml?.idpIssuer ?? "",
    idpCert: p?.saml?.idpCert ?? "",
    spEntityId: p?.saml?.spEntityId ?? "",
  };
}

function payload(v: Form, creating: boolean) {
  const common = {
    slug: v.slug.trim(),
    name: v.name.trim(),
    enabled: v.enabled,
    enforced: v.enforced,
    autoProvision: v.autoProvision,
    allowedDomains: v.allowedDomains
      .split(/[\s,]+/)
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
  };
  const oidc = { issuer: v.issuer.trim(), clientId: v.clientId.trim(), scopes: v.scopes.trim(), ...(v.clientSecret ? { clientSecret: v.clientSecret } : {}) };
  const saml = { entryPoint: v.entryPoint.trim(), idpIssuer: v.idpIssuer.trim(), idpCert: v.idpCert.trim(), spEntityId: v.spEntityId.trim() };
  const proto = v.type === "oidc" ? { oidc } : { saml };
  return creating ? { type: v.type, ...common, ...proto } : { ...common, ...proto };
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const t = useT();
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs" title={value}>
          {value}
        </code>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("sso.copyLabel", "Copy {label}", { label })}
          onClick={() => void navigator.clipboard.writeText(value).then(() => toast.success(t("sso.copied", "Copied")))}
        >
          <Copy aria-hidden />
        </Button>
      </div>
    </div>
  );
}

/** The URLs to register at the identity provider. */
function IdpUrls({ type, slug, spEntityId }: { type: SsoType; slug: string; spEntityId?: string }) {
  const t = useT();
  if (!slug) return <p className="text-xs text-muted-foreground">{t("sso.urlsNeedSlug", "Enter a slug to see the URLs for your identity provider.")}</p>;
  const base = `${typeof window === "undefined" ? "" : window.location.origin}/api/v1/sso/${encodeURIComponent(slug)}`;
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <p className="text-sm font-medium">{t("sso.giveIdp", "Give these to your identity provider")}</p>
      {type === "oidc" ? (
        <CopyRow label={t("sso.redirectUri", "Redirect (callback) URI")} value={`${base}/callback`} />
      ) : (
        <>
          <CopyRow label={t("sso.acsUrl", "Assertion consumer service (ACS) URL")} value={`${base}/acs`} />
          <CopyRow label={t("sso.entityId", "SP entity ID (audience)")} value={spEntityId || `${base}/metadata`} />
          <CopyRow label={t("sso.metadataUrl", "SP metadata URL")} value={`${base}/metadata`} />
        </>
      )}
    </div>
  );
}

function SwitchRow({ id, label, hint, checked, onChange, disabled }: { id: string; label: string; hint?: string; checked: boolean; onChange: (c: boolean) => void; disabled?: boolean }) {
  return (
    <label className="flex items-start gap-3 text-sm">
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} className="mt-0.5" aria-labelledby={`${id}-label`} aria-describedby={hint ? `${id}-hint` : undefined} />
      <span>
        <span id={`${id}-label`} className="font-medium">
          {label}
        </span>
        {hint && (
          <span id={`${id}-hint`} className="block text-muted-foreground">
            {hint}
          </span>
        )}
      </span>
    </label>
  );
}

function ProviderDialog({ provider, open, onOpenChange }: { provider: SsoProvider | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const creating = !provider;
  const [v, setV] = useState<Form>(() => toForm(provider));
  const [error, setError] = useState<unknown>(null);
  const set = <K extends keyof Form>(k: K, value: Form[K]) => setV((p) => ({ ...p, [k]: value }));
  const save = useMutation({
    mutationFn: () =>
      creating
        ? api<SsoProvider>("/sso/providers", { method: "POST", body: payload(v, true) })
        : api<SsoProvider>(`/sso/providers/${provider.id}`, { method: "PATCH", body: payload(v, false) }),
    onSuccess: () => {
      toast.success(t("sso.saved", "Provider saved"));
      void qc.invalidateQueries({ queryKey: providersKey });
      onOpenChange(false);
    },
    onError: setError,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{creating ? t("sso.newProvider", "New provider") : t("sso.editProvider", "Edit {name}", { name: provider.name })}</DialogTitle>
          <DialogDescription>{t("sso.formHelp", "Connect an OpenID Connect or SAML 2.0 identity provider.")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            save.mutate();
          }}
        >
          {error ? <ErrorAlert error={error} /> : null}
          <Field id="sso-type" label={t("sso.type", "Protocol")}>
            <NativeSelect id="sso-type" value={v.type} disabled={!creating} onChange={(e) => set("type", e.target.value as SsoType)}>
              <option value="oidc">OpenID Connect</option>
              <option value="saml">SAML 2.0</option>
            </NativeSelect>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="sso-name" label={t("sso.name", "Button label")} hint={t("sso.nameHint", "e.g. Google, Okta, Microsoft")}>
              <Input id="sso-name" required maxLength={100} value={v.name} onChange={(e) => set("name", e.target.value)} />
            </Field>
            <Field id="sso-slug" label={t("sso.slug", "Slug")} hint={t("sso.slugHint", "Lowercase letters, numbers and dashes.")}>
              <Input
                id="sso-slug"
                required
                maxLength={40}
                pattern="[a-z0-9](?:[a-z0-9\-]*[a-z0-9])?"
                value={v.slug}
                onChange={(e) => set("slug", e.target.value.toLowerCase())}
              />
            </Field>
          </div>

          {v.type === "oidc" ? (
            <>
              <Field id="sso-issuer" label={t("sso.issuer", "Issuer URL")} hint={t("sso.issuerHint", "We read {path} from it.", { path: "/.well-known/openid-configuration" })}>
                <Input id="sso-issuer" type="url" required value={v.issuer} onChange={(e) => set("issuer", e.target.value)} />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field id="sso-client" label={t("sso.clientId", "Client ID")}>
                  <Input id="sso-client" required autoComplete="off" maxLength={500} value={v.clientId} onChange={(e) => set("clientId", e.target.value)} />
                </Field>
                <Field
                  id="sso-secret"
                  label={t("sso.clientSecret", "Client secret")}
                  hint={provider?.oidc ? t("sso.secretStored", "Stored: {secret}. Leave blank to keep it.", { secret: provider.oidc.clientSecret }) : undefined}
                >
                  <Input
                    id="sso-secret"
                    type="password"
                    autoComplete="new-password"
                    required={creating}
                    maxLength={2000}
                    placeholder={provider?.oidc?.clientSecret ?? ""}
                    value={v.clientSecret}
                    onChange={(e) => set("clientSecret", e.target.value)}
                  />
                </Field>
              </div>
              <Field id="sso-scopes" label={t("sso.scopes", "Scopes")} hint={t("sso.scopesHint", "Default: openid email profile")}>
                <Input id="sso-scopes" maxLength={500} value={v.scopes} onChange={(e) => set("scopes", e.target.value)} />
              </Field>
            </>
          ) : (
            <>
              <Field id="sso-entry" label={t("sso.entryPoint", "IdP sign-in URL (entry point)")}>
                <Input id="sso-entry" type="url" required value={v.entryPoint} onChange={(e) => set("entryPoint", e.target.value)} />
              </Field>
              <Field id="sso-idp-issuer" label={t("sso.idpIssuer", "IdP entity ID")} hint={t("sso.optional", "Optional.")}>
                <Input id="sso-idp-issuer" maxLength={500} value={v.idpIssuer} onChange={(e) => set("idpIssuer", e.target.value)} />
              </Field>
              <Field
                id="sso-cert"
                label={t("sso.idpCert", "IdP signing certificate")}
                hint={
                  provider?.saml?.certificateExpiresAt
                    ? t("sso.certExpires", "Current certificate expires {date}.", { date: provider.saml.certificateExpiresAt.slice(0, 10) })
                    : t("sso.certHint", "PEM (-----BEGIN CERTIFICATE-----) or base64.")
                }
              >
                <Textarea id="sso-cert" required rows={4} className="font-mono text-xs" value={v.idpCert} onChange={(e) => set("idpCert", e.target.value)} />
              </Field>
              <Field id="sso-sp" label={t("sso.spEntityId", "Custom SP entity ID")} hint={t("sso.spEntityIdHint", "Optional. Defaults to the metadata URL.")}>
                <Input id="sso-sp" maxLength={500} value={v.spEntityId} onChange={(e) => set("spEntityId", e.target.value)} />
              </Field>
            </>
          )}

          <Field id="sso-domains" label={t("sso.allowedDomains", "Allowed email domains")} hint={t("sso.allowedDomainsHint", "One per line. Leave empty to allow any domain.")}>
            <Textarea id="sso-domains" rows={2} value={v.allowedDomains} onChange={(e) => set("allowedDomains", e.target.value)} placeholder="example.com" />
          </Field>
          <SwitchRow
            id="sso-auto"
            label={t("sso.autoProvision", "Create accounts automatically")}
            hint={t("sso.autoProvisionHint", "New people who sign in get an account (subject to your plan's user limit).")}
            checked={v.autoProvision}
            onChange={(c) => set("autoProvision", c)}
          />
          <SwitchRow id="sso-enabled" label={t("sso.enabled", "Show on the sign-in page")} checked={v.enabled} onChange={(c) => set("enabled", c)} />
          <SwitchRow
            id="sso-enforced"
            label={t("sso.enforced", "Require single sign-on")}
            hint={t("sso.enforcedHint", "Hides the password form. Organization admins can still sign in with a password.")}
            checked={v.enforced}
            onChange={(c) => set("enforced", c)}
          />

          <IdpUrls type={v.type} slug={v.slug} spEntityId={v.spEntityId} />

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("common.cancel", "Cancel")}
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? t("common.saving", "Saving…") : t("common.save", "Save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ProviderRow({ p, onEdit, onDelete }: { p: SsoProvider; onEdit: () => void; onDelete: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: (body: { enabled?: boolean; enforced?: boolean }) => api(`/sso/providers/${p.id}`, { method: "PATCH", body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: providersKey }),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const test = useMutation({
    mutationFn: () => api<{ ok: boolean; message: string }>(`/sso/providers/${p.id}/test`, { body: {} }),
    onSuccess: (r) => (r.ok ? toast.success(r.message) : toast.error(r.message)),
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <li className="space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 font-medium">
            {p.name}
            <Badge variant="outline">{p.type === "oidc" ? "OIDC" : "SAML"}</Badge>
            {p.enforced && p.enabled && <Badge>{t("sso.enforcedBadge", "Required")}</Badge>}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {p.slug} · {p.allowedDomains.length ? p.allowedDomains.join(", ") : t("sso.anyDomain", "any domain")}
            {p.autoProvision ? ` · ${t("sso.autoProvisionShort", "auto-provision")}` : ""}
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          <Button variant="outline" size="sm" disabled={test.isPending} onClick={() => test.mutate()}>
            <PlugZap aria-hidden /> {t("sso.test", "Test")}
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label={t("sso.editName", "Edit {name}", { name: p.name })} onClick={onEdit}>
            <Pencil aria-hidden />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label={t("sso.deleteName", "Delete {name}", { name: p.name })} onClick={onDelete}>
            <Trash2 aria-hidden />
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <SwitchRow id={`en-${p.id}`} label={t("sso.enabledShort", "Enabled")} checked={p.enabled} disabled={toggle.isPending} onChange={(c) => toggle.mutate({ enabled: c })} />
        <SwitchRow id={`ef-${p.id}`} label={t("sso.enforcedShort", "Required")} checked={p.enforced} disabled={toggle.isPending} onChange={(c) => toggle.mutate({ enforced: c })} />
      </div>
      <IdpUrls type={p.type} slug={p.slug} spEntityId={p.saml?.spEntityId ?? undefined} />
    </li>
  );
}

/** Organization policy: require MFA for administrators (settings.requireMfaForAdmins). */
function MfaPolicyCard() {
  const t = useT();
  const qc = useQueryClient();
  const org = useQuery({ queryKey: orgKey, queryFn: () => api<{ settings: Record<string, unknown> }>("/organization") });
  const save = useMutation({
    mutationFn: (value: boolean) => api<{ settings: Record<string, unknown> }>("/organization", { method: "PATCH", body: { settings: { requireMfaForAdmins: value } } }),
    onSuccess: (o, value) => {
      qc.setQueryData(orgKey, o);
      if (o.settings.requireMfaForAdmins !== value) toast.error(t("sso.policyNotSaved", "The server did not accept this setting."));
      else toast.success(t("sso.policySaved", "Policy saved"));
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("sso.policyTitle", "Two-factor authentication policy")}</CardTitle>
      </CardHeader>
      <CardContent>
        <QueryState query={org}>
          <SwitchRow
            id="mfa-policy"
            label={t("sso.requireMfaAdmins", "Require MFA for administrators")}
            hint={t("sso.requireMfaAdminsHint", "Organization admins and managers must set up two-factor authentication before they can use the site.")}
            checked={org.data?.settings.requireMfaForAdmins === true}
            disabled={save.isPending}
            onChange={(c) => save.mutate(c)}
          />
        </QueryState>
      </CardContent>
    </Card>
  );
}

function SsoAdminBody() {
  const t = useT();
  const qc = useQueryClient();
  const session = useSession();
  const providers = useQuery({ queryKey: providersKey, queryFn: () => api<SsoProvider[]>("/sso/providers/manage") });
  const [editing, setEditing] = useState<SsoProvider | "new" | null>(null);
  const [deleting, setDeleting] = useState<SsoProvider | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => api(`/sso/providers/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(t("sso.deleted", "Provider deleted"));
      setDeleting(null);
      void qc.invalidateQueries({ queryKey: providersKey });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <div className="space-y-4">
      <PageHeader
        title={t("sso.title", "Single sign-on")}
        description={t("sso.description", "Let people sign in with your organization's identity provider.")}
        actions={
          <Button onClick={() => setEditing("new")}>
            <Plus aria-hidden /> {t("sso.add", "Add provider")}
          </Button>
        }
      />
      <Card>
        <CardHeader>
          <CardTitle>{t("sso.providers", "Identity providers")}</CardTitle>
          <CardDescription>{t("sso.providersHelp", "Existing users are matched by email (within the allowed domains) and linked on first sign-in.")}</CardDescription>
        </CardHeader>
        <CardContent>
          <QueryState query={providers}>
            {providers.data?.length === 0 ? (
              <EmptyState title={t("sso.empty", "No providers yet")} description={t("sso.emptyHelp", "Add Google, Microsoft Entra ID, Okta or any OIDC / SAML provider.")} />
            ) : (
              <ul className="divide-y rounded-lg border">
                {providers.data?.map((p) => (
                  <ProviderRow key={p.id} p={p} onEdit={() => setEditing(p)} onDelete={() => setDeleting(p)} />
                ))}
              </ul>
            )}
          </QueryState>
        </CardContent>
      </Card>
      {session.can("site:config") && <MfaPolicyCard />}
      {editing && (
        <ProviderDialog
          key={editing === "new" ? "new" : editing.id}
          provider={editing === "new" ? null : editing}
          open
          onOpenChange={(o) => {
            if (!o) setEditing(null);
          }}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => {
          if (!o) setDeleting(null);
        }}
        title={t("sso.deleteTitle", "Delete {name}?", { name: deleting?.name ?? "" })}
        description={t("sso.deleteHelp", "Linked identities are removed. People keep their accounts but can no longer sign in with this provider.")}
        confirmLabel={t("common.delete", "Delete")}
        destructive
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </div>
  );
}

export function SsoAdmin() {
  return (
    <RequireCapability capability="site:manage_sso">
      <SsoAdminBody />
    </RequireCapability>
  );
}
