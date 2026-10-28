"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ErrorAlert, PageHeader, QueryState } from "@/components/common";
import { FileInput } from "@/components/file-input";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { meKey } from "@/lib/session";
import { Field, RequireCapability } from "./shared";
import type { Organization, OrgSettings } from "./types";

const orgKey = ["admin", "organization"] as const;

type FormState = {
  name: string;
  customDomain: string;
  selfRegistration: boolean;
  defaultLocale: string;
  defaultTimezone: string;
  brandColor: string;
  logoFileId: string | null;
  supportEmail: string;
};

const toForm = (o: Organization): FormState => ({
  name: o.name,
  customDomain: o.customDomain ?? "",
  selfRegistration: o.settings.selfRegistration ?? false,
  defaultLocale: o.settings.defaultLocale ?? "en",
  defaultTimezone: o.settings.defaultTimezone ?? "UTC",
  brandColor: o.settings.brandColor ?? "#2563eb",
  logoFileId: o.settings.logoFileId ?? null,
  supportEmail: o.settings.supportEmail ?? "",
});

function OrganizationForm({ org }: { org: Organization }) {
  const t = useT();
  const qc = useQueryClient();
  const [v, setV] = useState<FormState>(() => toForm(org));
  const [error, setError] = useState<unknown>(null);
  const set = <K extends keyof FormState>(k: K, value: FormState[K]) => setV((p) => ({ ...p, [k]: value }));
  const timezones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];

  const save = useMutation({
    mutationFn: () => {
      const settings: OrgSettings = {
        selfRegistration: v.selfRegistration,
        defaultLocale: v.defaultLocale,
        defaultTimezone: v.defaultTimezone,
        brandColor: v.brandColor,
        logoFileId: v.logoFileId,
        supportEmail: v.supportEmail || null,
      };
      return api<Organization>("/organization", {
        method: "PATCH",
        body: { name: v.name, customDomain: v.customDomain.trim().toLowerCase() || null, settings },
      });
    },
    onSuccess: (o) => {
      toast.success(t("admin.org.saved", "Organization settings saved"));
      qc.setQueryData(orgKey, o);
      void qc.invalidateQueries({ queryKey: meKey });
    },
    onError: setError,
  });

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
          <CardTitle>{t("admin.shared.general", "General")}</CardTitle>
          <CardDescription>
            {t("admin.org.address", "Address")} <code>{org.slug}</code> · {t("admin.org.plan", "plan")} <Badge variant="secondary">{org.plan}</Badge>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field id="org-name" label={t("admin.org.name", "Organization name")}>
            <Input id="org-name" required minLength={2} maxLength={100} value={v.name} onChange={(e) => set("name", e.target.value)} />
          </Field>
          <Field
            id="org-domain"
            label={t("admin.org.customDomain", "Custom domain")}
            hint={t("admin.org.customDomainHint", "Point a CNAME record at your LMS address first, e.g. learn.example.com. Leave blank to remove.")}
          >
            <Input
              id="org-domain"
              inputMode="url"
              pattern="[A-Za-z0-9.\-]+\.[A-Za-z]{2,}"
              placeholder="learn.example.com"
              value={v.customDomain}
              onChange={(e) => set("customDomain", e.target.value)}
            />
          </Field>
          <Field id="org-support" label={t("admin.org.supportEmail", "Support email")}>
            <Input id="org-support" type="email" value={v.supportEmail} onChange={(e) => set("supportEmail", e.target.value)} />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("admin.org.signupDefaults", "Sign-up & defaults")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="flex items-start gap-3 text-sm">
            <Switch
              checked={v.selfRegistration}
              onCheckedChange={(c) => set("selfRegistration", c)}
              className="mt-0.5"
              aria-labelledby="org-selfreg-label"
              aria-describedby="org-selfreg-desc"
            />
            <span>
              <span id="org-selfreg-label" className="font-medium">
                {t("admin.org.selfRegistration", "Allow self-registration")}
              </span>
              <span id="org-selfreg-desc" className="block text-muted-foreground">
                {t("admin.org.selfRegistrationHelp", "Anyone can create an account from the sign-in page.")}
              </span>
            </span>
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="org-locale" label={t("admin.org.defaultLanguage", "Default language")}>
              <Input id="org-locale" maxLength={10} value={v.defaultLocale} onChange={(e) => set("defaultLocale", e.target.value)} />
            </Field>
            <Field id="org-tz" label={t("admin.org.defaultTimezone", "Default time zone")}>
              <Input id="org-tz" list="org-tz-list" maxLength={64} value={v.defaultTimezone} onChange={(e) => set("defaultTimezone", e.target.value)} />
              <datalist id="org-tz-list">
                {timezones.map((tz) => (
                  <option key={tz} value={tz} />
                ))}
              </datalist>
            </Field>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("admin.org.branding", "Branding")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field id="org-color" label={t("admin.org.brandColor", "Brand color")}>
            <div className="flex items-center gap-2">
              <input
                id="org-color"
                type="color"
                className="h-8 w-12 cursor-pointer rounded border bg-background"
                value={v.brandColor}
                onChange={(e) => set("brandColor", e.target.value)}
              />
              <Input aria-label={t("admin.org.brandColorHex", "Brand color hex")} className="w-28 font-mono" pattern="#[0-9a-fA-F]{6}" value={v.brandColor} onChange={(e) => set("brandColor", e.target.value)} />
            </div>
          </Field>
          <Field id="org-logo" label={t("admin.org.logo", "Logo")}>
            <FileInput id="org-logo" accept="image/png,image/jpeg,image/svg+xml,image/webp" component="organization" area="logo" value={v.logoFileId} onChange={(id) => set("logoFileId", id)} />
          </Field>
        </CardContent>
      </Card>

      <Button type="submit" disabled={save.isPending}>
        {save.isPending ? t("common.saving", "Saving…") : t("admin.org.saveSettings", "Save settings")}
      </Button>
    </form>
  );
}

export function OrganizationAdmin() {
  const t = useT();
  const org = useQuery({ queryKey: orgKey, queryFn: () => api<Organization>("/organization") });
  return (
    <RequireCapability capability="site:config">
      <PageHeader title={t("admin.org.title", "Organization")} description={t("admin.org.description", "Name, domain, registration and branding.")} />
      <div className="max-w-3xl">
        <QueryState query={org}>{org.data && <OrganizationForm org={org.data} />}</QueryState>
      </div>
    </RequireCapability>
  );
}
