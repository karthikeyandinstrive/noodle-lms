"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { api } from "./api";

export type Me = {
  user: { id: string; email: string; firstName: string; lastName: string; locale: string; timezone: string } | null;
  organization: { id: string; name: string; slug: string; selfRegistration: boolean; systemContextId: string | null };
  /** Site-level capabilities (admin navigation). Course/activity capabilities come with those resources. */
  capabilities: Record<string, boolean>;
  /** Organization policy requires this user to set up MFA before using the app. */
  mfaEnrollmentRequired?: boolean;
};

export const meKey = ["me"] as const;

export function useSession() {
  const query = useQuery({ queryKey: meKey, queryFn: () => api<Me>("/auth/me"), staleTime: 60_000 });
  return {
    ...query,
    user: query.data?.user ?? null,
    organization: query.data?.organization,
    can: (capability: string) => query.data?.capabilities[capability] === true,
  };
}

export function useLogout() {
  const qc = useQueryClient();
  const router = useRouter();
  return async () => {
    await api("/auth/logout", { method: "POST", body: {} });
    qc.clear();
    router.replace("/login");
  };
}
