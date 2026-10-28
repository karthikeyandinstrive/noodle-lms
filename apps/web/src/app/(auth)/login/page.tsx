"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ErrorAlert } from "@/components/common";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { OtpInput } from "@/features/identity/mfa";
import { safeNext, type LoginResponse, type PublicSsoProvider } from "@/features/identity/types";
import { api, errorMessage } from "@/lib/api";
import { useT, type Translate } from "@/lib/i18n";
import { meKey, useSession } from "@/lib/session";

function ssoErrorMessage(code: string, t: Translate) {
  const messages: Record<string, string> = {
    sso_unavailable: t("login.error.unavailable", "That sign-in provider isn't available."),
    sso_state: t("login.error.state", "Your sign-in attempt expired. Please try again."),
    sso_email_missing: t("login.error.emailMissing", "Your identity provider didn't share an email address."),
    sso_email_unverified: t("login.error.emailUnverified", "Your email address isn't verified with your identity provider."),
    sso_domain_not_allowed: t("login.error.domain", "Your email domain isn't allowed to sign in here."),
    sso_no_account: t("login.error.noAccount", "There is no account for your email address. Ask an administrator to invite you."),
    sso_account_inactive: t("login.error.inactive", "This account is not active."),
    sso_plan_limit: t("login.error.planLimit", "This organization has reached its user limit. Contact an administrator."),
  };
  return messages[code] ?? t("login.error.generic", "Single sign-on failed. Please try again.");
}

function MfaStep({ challengeToken, onDone, onRestart }: { challengeToken: string; onDone: () => Promise<void>; onRestart: () => void }) {
  const t = useT();
  const [recovery, setRecovery] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("login.mfaTitle", "Two-factor authentication")}</CardTitle>
        <CardDescription>
          {recovery
            ? t("login.mfaRecoveryHelp", "Enter one of your recovery codes. Each code works once.")
            : t("login.mfaHelp", "Enter the 6-digit code from your authenticator app.")}
        </CardDescription>
      </CardHeader>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          setPending(true);
          try {
            await api("/auth/mfa/verify", { body: recovery ? { challengeToken, recoveryCode: value.trim() } : { challengeToken, code: value } });
            await onDone();
          } catch (err) {
            setError(err);
            setPending(false);
          }
        }}
      >
        <CardContent className="space-y-4">
          {error ? <ErrorAlert error={error} title={errorMessage(error)} /> : null}
          {recovery ? (
            <div className="space-y-1.5">
              <Label htmlFor="recoveryCode">{t("login.recoveryCode", "Recovery code")}</Label>
              <Input id="recoveryCode" name="recoveryCode" autoComplete="off" autoCapitalize="none" spellCheck={false} required maxLength={20} value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="code">{t("mfa.code", "Authentication code")}</Label>
              <OtpInput id="code" value={value} onChange={setValue} autoFocus />
            </div>
          )}
        </CardContent>
        <CardFooter className="mt-4 flex flex-col gap-3">
          <Button type="submit" className="w-full" disabled={pending || (!recovery && value.length !== 6)}>
            {pending ? t("common.pleaseWait", "Please wait…") : t("login.verify", "Verify")}
          </Button>
          <div className="flex w-full justify-between text-sm">
            <button
              type="button"
              className="text-primary hover:underline"
              onClick={() => {
                setRecovery(!recovery);
                setValue("");
                setError(null);
              }}
            >
              {recovery ? t("login.useApp", "Use your authenticator app") : t("login.useRecovery", "Use a recovery code")}
            </button>
            <button type="button" className="text-muted-foreground hover:underline" onClick={onRestart}>
              {t("login.startOver", "Start over")}
            </button>
          </div>
        </CardFooter>
      </form>
    </Card>
  );
}

export default function LoginPage() {
  const t = useT();
  const router = useRouter();
  const qc = useQueryClient();
  const { organization } = useSession();
  const providers = useQuery({ queryKey: ["sso", "providers"], queryFn: () => api<PublicSsoProvider[]>("/sso/providers"), staleTime: 60_000 });
  const [next, setNext] = useState("/dashboard");
  const [ssoError, setSsoError] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reading the URL once on mount
    setNext(safeNext(params.get("next")));
    const code = params.get("error");
    if (code) setSsoError(code);
  }, []);

  const finish = async () => {
    await qc.invalidateQueries({ queryKey: meKey });
    router.replace(next);
  };

  if (challenge) {
    return <MfaStep challengeToken={challenge} onDone={finish} onRestart={() => setChallenge(null)} />;
  }

  const list = providers.data ?? [];
  const enforced = list.some((p) => p.enforced);
  const passwordVisible = !enforced || showPassword;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{organization ? t("login.titleOrg", "Sign in to {name}", { name: organization.name }) : t("login.title", "Sign in")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {ssoError && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{ssoErrorMessage(ssoError, t)}</AlertDescription>
          </Alert>
        )}
        {list.length > 0 && (
          <div className="space-y-2">
            {list.map((p) => (
              // Full-page navigation: the API redirects to the identity provider.
              <a key={p.slug} href={`/api/v1/sso/${encodeURIComponent(p.slug)}/login?next=${encodeURIComponent(next)}`} className={buttonVariants({ variant: "outline", className: "w-full" })}>
                <KeyRound aria-hidden /> {t("login.continueWith", "Continue with {name}", { name: p.name })}
              </a>
            ))}
          </div>
        )}
        {list.length > 0 && passwordVisible && (
          <div className="flex items-center gap-3 text-xs text-muted-foreground" aria-hidden>
            <span className="h-px flex-1 bg-border" /> {t("login.or", "or")} <span className="h-px flex-1 bg-border" />
          </div>
        )}
        {passwordVisible ? (
          <form
            id="password-login"
            className="space-y-4"
            onSubmit={async (e) => {
              e.preventDefault();
              setError(null);
              setPending(true);
              const v = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
              try {
                const res = await api<LoginResponse>("/auth/login", { body: { email: v.email, password: v.password } });
                if ("mfaRequired" in res) {
                  setChallenge(res.challengeToken);
                  setPending(false);
                  return;
                }
                if (res.mfaEnrollmentRequired) {
                  await qc.invalidateQueries({ queryKey: meKey });
                  router.replace(`/mfa-setup?next=${encodeURIComponent(next)}`);
                  return;
                }
                await finish();
              } catch (err) {
                setError(err);
                setPending(false);
              }
            }}
          >
            {error ? <ErrorAlert error={error} title={errorMessage(error)} /> : null}
            <div className="space-y-1.5">
              <Label htmlFor="email">{t("auth.email", "Email")}</Label>
              <Input id="email" name="email" type="email" autoComplete="email" required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">{t("auth.password", "Password")}</Label>
              <Input id="password" name="password" type="password" autoComplete="current-password" required />
            </div>
            <Button type="submit" className="w-full" disabled={pending}>
              {pending ? t("common.pleaseWait", "Please wait…") : t("login.submit", "Sign in")}
            </Button>
          </form>
        ) : (
          <button type="button" className="w-full text-center text-sm text-muted-foreground hover:underline" onClick={() => setShowPassword(true)}>
            {t("login.withPassword", "Sign in with password (administrators)")}
          </button>
        )}
      </CardContent>
      {passwordVisible && (
        <CardFooter className="mt-2 flex w-full justify-between text-sm">
          <Link className="text-muted-foreground hover:underline" href="/forgot-password">
            {t("login.forgot", "Forgot password?")}
          </Link>
          {organization?.selfRegistration && !enforced && (
            <Link className="text-primary hover:underline" href="/register">
              {t("login.createAccount", "Create account")}
            </Link>
          )}
        </CardFooter>
      )}
    </Card>
  );
}
