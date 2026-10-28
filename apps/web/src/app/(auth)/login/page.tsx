"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { api } from "@/lib/api";
import { meKey, useSession } from "@/lib/session";

export default function LoginPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const { organization } = useSession();

  return (
    <AuthForm
      title={organization ? `Sign in to ${organization.name}` : "Sign in"}
      fields={[
        { name: "email", label: "Email", type: "email", autoComplete: "email" },
        { name: "password", label: "Password", type: "password", autoComplete: "current-password" },
      ]}
      submitLabel="Sign in"
      onSubmit={async (v) => {
        await api("/auth/login", { body: { email: v.email, password: v.password } });
        await qc.invalidateQueries({ queryKey: meKey });
        const next = new URLSearchParams(window.location.search).get("next");
        // Only allow same-site relative redirects (no open redirect).
        router.replace(next && next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard");
      }}
      footer={
        <div className="flex w-full justify-between text-sm">
          <Link className="text-muted-foreground hover:underline" href="/forgot-password">
            Forgot password?
          </Link>
          {organization?.selfRegistration && (
            <Link className="text-primary hover:underline" href="/register">
              Create account
            </Link>
          )}
        </div>
      }
    />
  );
}
