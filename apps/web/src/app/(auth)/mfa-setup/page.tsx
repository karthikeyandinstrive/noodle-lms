"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MfaEnrollment } from "@/features/identity/mfa";
import { safeNext } from "@/features/identity/types";
import { useT } from "@/lib/i18n";
import { meKey, useLogout } from "@/lib/session";

/**
 * Forced enrollment: the organization requires MFA for administrators. Until the
 * user enrolls, the API only allows /auth/me, /auth/mfa/* and logout.
 */
export default function MfaSetupPage() {
  const t = useT();
  const router = useRouter();
  const qc = useQueryClient();
  const logout = useLogout();
  const [next, setNext] = useState("/dashboard");

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reading the URL once on mount
    setNext(safeNext(new URLSearchParams(window.location.search).get("next")));
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("mfaSetup.title", "Set up two-factor authentication")}</CardTitle>
        <CardDescription>{t("mfaSetup.description", "Your organization requires administrators to use two-factor authentication before continuing.")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <MfaEnrollment
          onDone={async () => {
            await qc.invalidateQueries({ queryKey: meKey });
            router.replace(next);
          }}
        />
        <Button variant="ghost" className="w-full" onClick={() => void logout()}>
          {t("mfaSetup.signOut", "Sign out")}
        </Button>
      </CardContent>
    </Card>
  );
}
