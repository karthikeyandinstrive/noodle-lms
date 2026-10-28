"use client";

import Link from "next/link";
import { useState } from "react";
import { AuthForm } from "@/components/auth-form";
import { api } from "@/lib/api";

export default function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  return (
    <AuthForm
      title="Reset your password"
      description="We'll email you a link to choose a new password."
      fields={[{ name: "email", label: "Email", type: "email", autoComplete: "email" }]}
      submitLabel="Send reset link"
      success={sent ? "If an account exists for that email, a reset link is on its way." : null}
      onSubmit={async (v) => {
        await api("/auth/password/forgot", { body: { email: v.email } });
        setSent(true);
      }}
      footer={
        <Link className="text-sm text-muted-foreground hover:underline" href="/login">
          Back to sign in
        </Link>
      }
    />
  );
}
