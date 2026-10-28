"use client";

import { useQuery } from "@tanstack/react-query";
import { api, type Paged } from "@/lib/api";
import type { CapabilityDef, Permission, Role, RoleAssignment } from "../admin/types";

/** Mirrors GET /contexts/:contextId/overrides. */
export type Override = { id: string; roleId: string; capability: string; permission: Permission };

export type ContextLevel = "course" | "activity";

export const permissionKeys = {
  roles: ["roles"] as const,
  capabilities: ["capabilities"] as const,
  overrides: (contextId: string) => ["permissions", contextId, "overrides"] as const,
  assignments: (contextId: string) => ["permissions", contextId, "assignments"] as const,
  myCaps: (contextId: string, caps: string) => ["permissions", contextId, "me", caps] as const,
};

export const useRoles = () => useQuery({ queryKey: permissionKeys.roles, queryFn: () => api<Role[]>("/roles") });

export const useCapabilityDefs = () =>
  useQuery({ queryKey: permissionKeys.capabilities, queryFn: () => api<CapabilityDef[]>("/capabilities"), staleTime: Infinity });

export const useOverrides = (contextId: string) =>
  useQuery({ queryKey: permissionKeys.overrides(contextId), queryFn: () => api<Override[]>(`/contexts/${contextId}/overrides`) });

export const useRoleAssignments = (contextId: string) =>
  useQuery({ queryKey: permissionKeys.assignments(contextId), queryFn: () => api<RoleAssignment[]>(`/contexts/${contextId}/role-assignments`) });

/** Evaluates capabilities for the current user in a context (GET /me/capabilities). */
export const useMyCapabilities = (contextId: string | undefined, caps: string[]) =>
  useQuery({
    queryKey: permissionKeys.myCaps(contextId ?? "", caps.join(",")),
    queryFn: () => api<Record<string, boolean>>("/me/capabilities", { query: { contextId, capabilities: caps.join(",") } }),
    enabled: !!contextId,
  });

export type Participant = { id: string; firstName: string; lastName: string; email?: string };

export const useCourseParticipants = (courseId: string, search: string) =>
  useQuery({
    queryKey: ["permissions", "participants", courseId, search] as const,
    queryFn: () => api<Paged<Participant>>(`/courses/${courseId}/participants`, { query: { search: search || undefined, pageSize: 20 } }),
    enabled: !!courseId,
  });
