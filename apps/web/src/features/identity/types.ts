export type SsoType = "oidc" | "saml";

/** Public list for the login page. */
export type PublicSsoProvider = { slug: string; name: string; type: SsoType; enforced: boolean };

export type SsoProvider = {
  id: string;
  type: SsoType;
  slug: string;
  name: string;
  enabled: boolean;
  enforced: boolean;
  autoProvision: boolean;
  allowedDomains: string[];
  oidc: { issuer: string; clientId: string; clientSecret: string; scopes: string | null } | null;
  saml: { entryPoint: string; idpIssuer: string | null; idpCert: string; spEntityId: string | null; certificateExpiresAt: string | null } | null;
  urls: { login: string; callback: string | null; acs: string | null; metadata: string | null; spEntityId: string | null };
  createdAt: string;
  updatedAt: string;
};

export type MfaStatus = { enabled: boolean; pending: boolean; enabledAt: string | null; recoveryCodesRemaining: number; required: boolean };

export type LoginResponse =
  | { user: { id: string; email: string }; mfaEnrollmentRequired?: boolean }
  | { mfaRequired: true; challengeToken: string };

/** Same-site relative redirect targets only (mirrors the API's sanitizer). */
export function safeNext(next: string | null | undefined, fallback = "/dashboard") {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return fallback;
  if (/[\u0000-\u001f\u007f]/.test(next)) return fallback;
  return next;
}
