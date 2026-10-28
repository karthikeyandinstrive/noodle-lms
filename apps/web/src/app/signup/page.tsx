"use client";

import { CheckCircle2, GraduationCap } from "lucide-react";
import Link from "next/link";
import { useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ErrorAlert } from "@/components/common";
import { api } from "@/lib/api";

const noopSubscribe = () => () => {};
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;

/** Derives a URL-safe address from the organization name. */
function slugify(name: string) {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
}

export default function SignupPage() {
  const [v, setV] = useState({ name: "", slug: "", firstName: "", lastName: "", email: "", password: "" });
  const [slugEdited, setSlugEdited] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<{ url: string } | null>(null);
  const host = useSyncExternalStore(
    noopSubscribe,
    () => window.location.hostname.replace(/^www\./, ""),
    () => "",
  );
  const slugValid = SLUG_RE.test(v.slug);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!slugValid) {
      setError(new Error("The address must be 3–32 lowercase letters, numbers or dashes, and can't start or end with a dash."));
      return;
    }
    setPending(true);
    try {
      const r = await api<{ organizationId: string; url: string }>("/organizations/signup", {
        body: { name: v.name.trim(), slug: v.slug, admin: { email: v.email.trim(), password: v.password, firstName: v.firstName.trim(), lastName: v.lastName.trim() } },
      });
      setDone({ url: r.url });
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
    }
  }

  const loginUrl = done ? new URL("/login", done.url).toString() : "";

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-muted/40 px-4 py-10">
      <div className="mb-6 flex items-center gap-2 text-lg font-semibold">
        <GraduationCap className="size-6 text-primary" /> LMS
      </div>
      <div className="w-full max-w-md">
        {done ? (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CheckCircle2 className="size-5 text-green-600" /> Your organization is ready
              </CardTitle>
              <CardDescription>Sign in with the administrator account you just created.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p>Your learning site address:</p>
              <p className="rounded-md border bg-muted/50 p-2 font-mono break-all">{done.url}</p>
            </CardContent>
            <CardFooter>
              <Button className="w-full" render={<a href={loginUrl} />}>
                Go to sign in
              </Button>
            </CardFooter>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Create your organization</CardTitle>
              <CardDescription>Start free with up to 50 users and 5 courses. Upgrade any time.</CardDescription>
            </CardHeader>
            <form onSubmit={submit}>
              <CardContent className="space-y-4">
                {error ? <ErrorAlert error={error} title="Could not create the organization" /> : null}
                <div className="space-y-1.5">
                  <Label htmlFor="org-name">Organization name</Label>
                  <Input
                    id="org-name"
                    required
                    minLength={2}
                    maxLength={100}
                    autoComplete="organization"
                    value={v.name}
                    onChange={(e) => setV({ ...v, name: e.target.value, slug: slugEdited ? v.slug : slugify(e.target.value) })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="org-slug">Site address</Label>
                  <div className="flex items-center gap-1">
                    <Input
                      id="org-slug"
                      required
                      maxLength={32}
                      pattern="[a-z0-9][a-z0-9\-]{1,30}[a-z0-9]"
                      aria-describedby="org-slug-hint"
                      aria-invalid={v.slug !== "" && !slugValid}
                      value={v.slug}
                      onChange={(e) => {
                        setSlugEdited(true);
                        setV({ ...v, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") });
                      }}
                    />
                    {host && <span className="shrink-0 text-sm text-muted-foreground">.{host}</span>}
                  </div>
                  <p id="org-slug-hint" className="text-xs text-muted-foreground">
                    Lowercase letters, numbers and dashes.
                  </p>
                </div>
                <fieldset className="space-y-4">
                  <legend className="mb-2 text-sm font-medium">Administrator account</legend>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="adm-first">First name</Label>
                      <Input id="adm-first" required maxLength={100} autoComplete="given-name" value={v.firstName} onChange={(e) => setV({ ...v, firstName: e.target.value })} />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="adm-last">Last name</Label>
                      <Input id="adm-last" required maxLength={100} autoComplete="family-name" value={v.lastName} onChange={(e) => setV({ ...v, lastName: e.target.value })} />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="adm-email">Email</Label>
                    <Input id="adm-email" type="email" required autoComplete="email" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="adm-pass">Password</Label>
                    <Input
                      id="adm-pass"
                      type="password"
                      required
                      minLength={10}
                      maxLength={200}
                      autoComplete="new-password"
                      aria-describedby="adm-pass-hint"
                      value={v.password}
                      onChange={(e) => setV({ ...v, password: e.target.value })}
                    />
                    <p id="adm-pass-hint" className="text-xs text-muted-foreground">
                      At least 10 characters.
                    </p>
                  </div>
                </fieldset>
              </CardContent>
              <CardFooter className="flex-col items-stretch gap-3">
                <Button type="submit" disabled={pending}>
                  {pending ? "Creating…" : "Create organization"}
                </Button>
                <Link href="/login" className="text-center text-sm text-muted-foreground hover:underline">
                  Already have a site? Sign in
                </Link>
              </CardFooter>
            </form>
          </Card>
        )}
      </div>
    </div>
  );
}
