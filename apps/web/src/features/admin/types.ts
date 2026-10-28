import type { Translate } from "@/lib/i18n";

/** Admin API shapes (mirror the Zod response schemas in apps/api modules users/roles/organization/courses). */

export type UserStatus = "active" | "suspended" | "pending";

export type AdminUser = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  bio: string | null;
  avatarFileId: string | null;
  locale: string;
  timezone: string;
  status: UserStatus;
  emailVerifiedAt: string | null;
  lastLoginAt: string | null;
  createdAt: string;
};

export type AdminUserDetail = AdminUser & {
  siteRoles: string[];
  courses: { id: string; fullname: string; status: string }[];
};

export type Permission = "allow" | "prevent" | "prohibit";

export type Role = {
  id: string;
  shortname: string;
  name: string;
  description: string | null;
  archetype: string;
  assignableLevels: string[];
  capabilities: Record<string, Permission>;
};

export type CapabilityDef = { name: string; description: string; level: string; risky: boolean };

export type RoleAssignment = {
  id: string;
  roleId: string;
  roleName: string;
  user: { id: string; firstName: string; lastName: string; email: string };
};

export type Cohort = { id: string; name: string; idnumber: string | null; description: string | null; memberCount: number };
export type CohortMember = { id: string; firstName: string; lastName: string; email: string };

export type Category = { id: string; parentId: string | null; name: string; description: string | null; sortOrder: number; visible: boolean };

export type OrgSettings = {
  selfRegistration?: boolean;
  defaultLocale?: string;
  defaultTimezone?: string;
  brandColor?: string;
  logoFileId?: string | null;
  supportEmail?: string | null;
};

export type Organization = { id: string; name: string; slug: string; customDomain: string | null; plan: string; settings: OrgSettings };

export type StorageConfig = {
  provider: "local" | "s3" | "minio" | "r2";
  enabled: boolean;
  endpoint: string | null;
  region: string | null;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicUrl: string | null;
};

export type AuditEntry = {
  id: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
  actor: { id: string; firstName: string; lastName: string } | null;
};

export type Participant = {
  id: string;
  firstName: string;
  lastName: string;
  email?: string;
  roles: string[];
  status: "active" | "suspended";
  method: string;
  enrolledAt: string;
  lastLoginAt: string | null;
};

export type Group = { id: string; name: string; description: string | null; memberIds: string[] };

export const ENROL_ROLES = [
  { value: "student", key: "admin.roles.enrol.student", label: "Student" },
  { value: "teacher", key: "admin.roles.enrol.teacher", label: "Non-editing teacher" },
  { value: "editing_teacher", key: "admin.roles.enrol.editingTeacher", label: "Teacher" },
  { value: "guest", key: "admin.roles.enrol.guest", label: "Guest" },
] as const;

export const roleLabel = (shortname: string, t: Translate) => {
  const r = ENROL_ROLES.find((x) => x.value === shortname);
  return r ? t(r.key, r.label) : shortname;
};
