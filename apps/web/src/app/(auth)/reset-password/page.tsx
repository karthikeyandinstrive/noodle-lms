"use client";

import { useRouter } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { api } from "@/lib/api";

export default function Page() {
  const router = useRouter();
  return (
    <AuthForm
      title="Choose a new password"
      description="Use at least 10 characters with letters and numbers."
      fields={[{ name: "password", label: "New password", type: "password", autoComplete: "new-password", minLength: 10 }]}
      submitLabel="Save password"
      onSubmit={async (v) => {
        const token = new URLSearchParams(window.location.search).get("token") ?? "";
        await api("/auth/password/reset", { body: { token, password: v.password } });
        router.replace("/login");
      }}
    />
  );
}
