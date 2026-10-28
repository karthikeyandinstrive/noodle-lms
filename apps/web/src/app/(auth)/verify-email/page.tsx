"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, errorMessage } from "@/lib/api";

export default function VerifyEmailPage() {
  const [state, setState] = useState<{ done: boolean; error?: string }>({ done: false });
  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("token") ?? "";
    api("/auth/verify-email", { body: { token } })
      .then(() => setState({ done: true }))
      .catch((e) => setState({ done: true, error: errorMessage(e) }));
  }, []);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Email confirmation</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!state.done ? "Confirming…" : state.error ? state.error : "Your email is confirmed."}
        <div>
          <Link href="/dashboard" className="text-primary hover:underline">
            Continue
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
