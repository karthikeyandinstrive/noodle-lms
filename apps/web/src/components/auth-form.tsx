"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { ErrorAlert } from "./common";

type Field = { name: string; label: string; type?: string; autoComplete?: string; required?: boolean; minLength?: number };

/** Compact card form used by the sign-in / password flows. */
export function AuthForm({
  title,
  description,
  fields,
  submitLabel,
  onSubmit,
  footer,
  success,
}: {
  title: string;
  description?: string;
  fields: Field[];
  submitLabel: string;
  onSubmit: (values: Record<string, string>) => Promise<void>;
  footer?: React.ReactNode;
  success?: string | null;
}) {
  const t = useT();
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);

  async function handle(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await onSubmit(Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>);
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <form onSubmit={handle}>
        <CardContent className="space-y-4">
          {error ? <ErrorAlert error={error} title={errorMessage(error)} /> : null}
          {success ? <p className="rounded-md bg-muted p-3 text-sm">{success}</p> : null}
          {fields.map((f) => (
            <div key={f.name} className="space-y-1.5">
              <Label htmlFor={f.name}>{f.label}</Label>
              <Input id={f.name} name={f.name} type={f.type ?? "text"} autoComplete={f.autoComplete} required={f.required ?? true} minLength={f.minLength} />
            </div>
          ))}
        </CardContent>
        <CardFooter className="mt-4 flex flex-col gap-3">
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? t("common.pleaseWait", "Please wait…") : submitLabel}
          </Button>
          {footer}
        </CardFooter>
      </form>
    </Card>
  );
}
