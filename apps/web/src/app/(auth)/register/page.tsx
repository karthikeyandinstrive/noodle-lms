"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { api } from "@/lib/api";
import { meKey } from "@/lib/session";

export default function RegisterPage() {
  const router = useRouter();
  const qc = useQueryClient();
  return (
    <AuthForm
      title="Create your account"
      description="Use at least 10 characters with letters and numbers."
      fields={[
        { name: "firstName", label: "First name", autoComplete: "given-name" },
        { name: "lastName", label: "Last name", autoComplete: "family-name" },
        { name: "email", label: "Email", type: "email", autoComplete: "email" },
        { name: "password", label: "Password", type: "password", autoComplete: "new-password", minLength: 10 },
      ]}
      submitLabel="Create account"
      onSubmit={async (v) => {
        await api("/auth/register", { body: v });
        await qc.invalidateQueries({ queryKey: meKey });
        router.replace("/dashboard");
      }}
      footer={
        <Link className="text-sm text-muted-foreground hover:underline" href="/login">
          Already have an account? Sign in
        </Link>
      }
    />
  );
}
