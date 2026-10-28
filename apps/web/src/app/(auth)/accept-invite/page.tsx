"use client";

import { useRouter } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { api } from "@/lib/api";

export default function Page() {
  const router = useRouter();
  return (
    <AuthForm
      title="Set your password"
      description="Use at least 10 characters with letters and numbers."
      fields={[{ name: "password", label: "New password", type: "password", autoComplete: "new-password", minLength: 10 }]}
      submitLabel="Activate account"
      onSubmit={async (v) => {
        const token = new URLSearchParams(window.location.search).get("token") ?? "";
        await api("/users/accept-invite", { body: { token, password: v.password } });
        router.replace("/login");
      }}
    />
  );
}
