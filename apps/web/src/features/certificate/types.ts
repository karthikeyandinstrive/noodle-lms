import type { UserSummary } from "@/lib/types";
import type { IssueStatus } from "./shared";

export type CertificateElement = {
  type: "text" | "image" | "qrcode";
  x: number;
  y: number;
  width?: number;
  fontSize?: number;
  color?: string;
  align?: "left" | "center" | "right";
  text?: string;
  fileId?: string;
};

export type CertificateTemplate = {
  id: string;
  name: string;
  orientation: "landscape" | "portrait";
  backgroundFileId: string | null;
  elements: CertificateElement[];
  createdAt: string;
};

export type IssuedCertificate = {
  id: string;
  code: string;
  issuedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  status: IssueStatus;
  hasFile: boolean;
};

export type CertificateStatus = {
  certificate: IssuedCertificate | null;
  eligible: boolean;
  courseCompleted: boolean;
  gradePercent: number | null;
  reasons: string[];
  enrolled: boolean;
};

export type IssuedListRow = { user: UserSummary; certificate: IssuedCertificate | null };

export type MyCertificate = IssuedCertificate & { activityId: string; activityName: string; courseId: string; courseName: string };

export const certificateDownloadUrl = (id: string, inline = false) => `/api/v1/certificates/issued/${id}/download${inline ? "?inline=true" : ""}`;
export const verifyPath = (code: string) => `/verify/${encodeURIComponent(code)}`;

export const PLACEHOLDER_HELP = ["{{fullname}}", "{{coursename}}", "{{date}}", "{{code}}", "{{grade}}", "{{orgname}}"];
export const SAMPLE_VALUES: Record<string, string> = {
  fullname: "Alex Example",
  coursename: "Sample Course",
  date: new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }),
  code: "ABCD-EFGH-JKLM",
  grade: "92%",
  orgname: "Your Organization",
};

export function renderPlaceholders(text: string, values: Record<string, string>) {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (m, k: string) => values[k.toLowerCase()] ?? m);
}
