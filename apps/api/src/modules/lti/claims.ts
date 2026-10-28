/**
 * LTI 1.3 / LTI Advantage — pure helpers (no I/O), unit-tested in lti.test.ts.
 *
 * We are the *platform* (tool consumer). Message flow:
 *   1. GET  /lti/:activityId/launch  → auto-submitting form to the tool's OIDC login URL
 *                                      (third-party initiated login).
 *   2. Tool → GET|POST /lti/auth     → we validate the OIDC authentication request and answer
 *                                      with an auto-submitting form POSTing `id_token` + `state`
 *                                      to the tool's registered redirect_uri.
 *   3. Tool → POST /lti/token        → OAuth2 client_credentials with a JWT client assertion
 *                                      (signed by the tool, verified with its JWKS).
 *   4. Tool → AGS / NRPS services     → bearer access token from step 3.
 */

export const LTI = {
  messageType: "https://purl.imsglobal.org/spec/lti/claim/message_type",
  version: "https://purl.imsglobal.org/spec/lti/claim/version",
  deploymentId: "https://purl.imsglobal.org/spec/lti/claim/deployment_id",
  targetLinkUri: "https://purl.imsglobal.org/spec/lti/claim/target_link_uri",
  resourceLink: "https://purl.imsglobal.org/spec/lti/claim/resource_link",
  roles: "https://purl.imsglobal.org/spec/lti/claim/roles",
  context: "https://purl.imsglobal.org/spec/lti/claim/context",
  toolPlatform: "https://purl.imsglobal.org/spec/lti/claim/tool_platform",
  launchPresentation: "https://purl.imsglobal.org/spec/lti/claim/launch_presentation",
  custom: "https://purl.imsglobal.org/spec/lti/claim/custom",
  ags: "https://purl.imsglobal.org/spec/lti-ags/claim/endpoint",
  nrps: "https://purl.imsglobal.org/spec/lti-nrps/claim/namesroleservice",
  deepLinkingSettings: "https://purl.imsglobal.org/spec/lti-dl/claim/deep_linking_settings",
  contentItems: "https://purl.imsglobal.org/spec/lti-dl/claim/content_items",
  dlData: "https://purl.imsglobal.org/spec/lti-dl/claim/data",
  dlMessage: "https://purl.imsglobal.org/spec/lti-dl/claim/msg",
  dlErrorMessage: "https://purl.imsglobal.org/spec/lti-dl/claim/errormsg",
} as const;

export const SCOPES = {
  lineItem: "https://purl.imsglobal.org/spec/lti-ags/scope/lineitem",
  lineItemReadonly: "https://purl.imsglobal.org/spec/lti-ags/scope/lineitem.readonly",
  score: "https://purl.imsglobal.org/spec/lti-ags/scope/score",
  memberships: "https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly",
} as const;

/** Services a tool may be granted (tool.scopes is a subset of these). */
export const SUPPORTED_SCOPES: string[] = Object.values(SCOPES);
export const AGS_SCOPES: string[] = [SCOPES.lineItem, SCOPES.lineItemReadonly, SCOPES.score];

export const ROLES = {
  learner: "http://purl.imsglobal.org/vocab/lis/v2/membership#Learner",
  instructor: "http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor",
  contextAdmin: "http://purl.imsglobal.org/vocab/lis/v2/membership#Administrator",
  institutionAdmin: "http://purl.imsglobal.org/vocab/lis/v2/institution/person#Administrator",
  systemAdmin: "http://purl.imsglobal.org/vocab/lis/v2/system/person#Administrator",
} as const;

export const COURSE_OFFERING = "http://purl.imsglobal.org/vocab/lis/v2/course#CourseOffering";

export const MEDIA = {
  lineItem: "application/vnd.ims.lis.v2.lineitem+json",
  lineItemContainer: "application/vnd.ims.lis.v2.lineitemcontainer+json",
  score: "application/vnd.ims.lis.v1.score+json",
  memberships: "application/vnd.ims.lti-nrps.v2.membershipcontainer+json",
} as const;

/** LIS role URIs for the launching user, derived from their capabilities in the activity / site. */
export function rolesFor(input: { canEdit: boolean; canGrade: boolean; isSiteAdmin: boolean }): string[] {
  const roles: string[] = [];
  if (input.isSiteAdmin) roles.push(ROLES.institutionAdmin, ROLES.systemAdmin, ROLES.contextAdmin);
  if (input.canEdit || input.canGrade) roles.push(ROLES.instructor);
  if (!roles.length) roles.push(ROLES.learner);
  return roles;
}

/** NRPS role mapping from our course role archetypes. */
export function rolesForArchetypes(archetypes: string[]): string[] {
  const out = new Set<string>();
  for (const a of archetypes) {
    if (a === "editing_teacher" || a === "teacher") out.add(ROLES.instructor);
    else if (a === "manager" || a === "org_admin" || a === "super_admin") out.add(ROLES.contextAdmin);
    else if (a === "student" || a === "guest") out.add(ROLES.learner);
  }
  return [...out];
}

// ─── Custom parameters ──────────────────────────────────────────────────────

export const CUSTOM_KEY = /^[A-Za-z0-9_.-]{1,100}$/;

/** Parses "key=value" lines (as typed by teachers) into a map. Throws on malformed lines. */
export function parseCustomParams(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i <= 0) throw new Error(`Invalid custom parameter line: ${line.slice(0, 50)}`);
    const key = line.slice(0, i).trim();
    if (!CUSTOM_KEY.test(key)) throw new Error(`Invalid custom parameter name: ${key.slice(0, 50)}`);
    out[key] = line.slice(i + 1).trim();
  }
  return out;
}

/**
 * Substitutes the LTI variables we support in custom parameter values
 * (unknown `$Variables` are passed through unchanged, as the spec requires).
 */
export function substituteCustom(params: Record<string, string>, vars: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    out[k] = v.startsWith("$") && vars[v] !== undefined ? vars[v]! : v;
  }
  return out;
}

// ─── OIDC authentication request (tool → platform) ──────────────────────────

export type AuthRequest = {
  scope?: string;
  response_type?: string;
  response_mode?: string;
  prompt?: string;
  client_id?: string;
  redirect_uri?: string;
  login_hint?: string;
  lti_message_hint?: string;
  state?: string;
  nonce?: string;
};

/** Static checks of the authentication request (OIDC + LTI 1.3 §5.1.1.2). Returns an error message or null. */
export function checkAuthRequest(p: AuthRequest, tool: { clientId: string; redirectUris: string[] }): string | null {
  if (p.response_type !== "id_token") return "response_type must be id_token";
  if (!(p.scope ?? "").split(" ").includes("openid")) return "scope must include openid";
  if (p.response_mode !== "form_post") return "response_mode must be form_post";
  if (p.prompt !== "none") return "prompt must be none";
  if (!p.nonce) return "nonce is required";
  if (!p.login_hint || !p.lti_message_hint) return "login_hint and lti_message_hint are required";
  if (p.client_id !== tool.clientId) return "client_id does not match the tool";
  if (!p.redirect_uri || !tool.redirectUris.includes(p.redirect_uri)) return "redirect_uri is not registered for this tool";
  return null;
}

// ─── id_token (LtiResourceLinkRequest) ──────────────────────────────────────

export type LaunchInput = {
  issuer: string;
  clientId: string;
  deploymentId: string;
  nonce: string;
  now?: number;
  user: { id: string; firstName: string; lastName: string; email: string; locale: string };
  sharePersonalData: boolean;
  roles: string[];
  activity: { id: string; name: string; description: string | null };
  course: { id: string; shortname: string; fullname: string };
  targetLinkUri: string;
  documentTarget: "iframe" | "window";
  returnUrl: string;
  custom: Record<string, string>;
  platform: { guid: string; name: string };
  /** Present when the activity is graded and the tool may use AGS. */
  ags?: { scopes: string[]; lineItemUrl: string; lineItemsUrl: string } | null;
  /** Present when the tool may use NRPS. */
  nrps?: { membershipsUrl: string } | null;
  /** Makes this a Deep Linking request (content selection) instead of a resource link launch. */
  deepLinking?: { returnUrl: string; data: string } | null;
};

export const ID_TOKEN_TTL_SECONDS = 300;

export function buildLaunchClaims(i: LaunchInput): Record<string, unknown> {
  const iat = Math.floor((i.now ?? Date.now()) / 1000);
  const claims: Record<string, unknown> = {
    iss: i.issuer,
    aud: i.clientId,
    azp: i.clientId,
    sub: i.user.id,
    iat,
    exp: iat + ID_TOKEN_TTL_SECONDS,
    nonce: i.nonce,
    locale: i.user.locale,
    [LTI.messageType]: i.deepLinking ? "LtiDeepLinkingRequest" : "LtiResourceLinkRequest",
    [LTI.version]: "1.3.0",
    [LTI.deploymentId]: i.deploymentId,
    [LTI.targetLinkUri]: i.targetLinkUri,
    [LTI.roles]: i.roles,
    [LTI.context]: { id: i.course.id, label: i.course.shortname, title: i.course.fullname, type: [COURSE_OFFERING] },
    [LTI.toolPlatform]: { guid: i.platform.guid, name: i.platform.name, product_family_code: "lms-moodle-v1", version: "1.0" },
    [LTI.launchPresentation]: { document_target: i.documentTarget, return_url: i.returnUrl, locale: i.user.locale },
  };
  if (i.deepLinking) {
    claims[LTI.deepLinkingSettings] = {
      deep_link_return_url: i.deepLinking.returnUrl,
      accept_types: ["ltiResourceLink"],
      accept_presentation_document_targets: ["iframe", "window"],
      accept_multiple: false,
      auto_create: false,
      title: i.activity.name,
      data: i.deepLinking.data,
    };
  } else {
    claims[LTI.resourceLink] = {
      id: i.activity.id,
      title: i.activity.name,
      ...(i.activity.description ? { description: stripTags(i.activity.description).slice(0, 1000) } : {}),
    };
  }
  if (Object.keys(i.custom).length) claims[LTI.custom] = i.custom;
  if (i.sharePersonalData) {
    claims.name = `${i.user.firstName} ${i.user.lastName}`.trim();
    claims.given_name = i.user.firstName;
    claims.family_name = i.user.lastName;
    claims.email = i.user.email;
  }
  if (i.ags && i.ags.scopes.length) {
    claims[LTI.ags] = { scope: i.ags.scopes, lineitem: i.ags.lineItemUrl, lineitems: i.ags.lineItemsUrl };
  }
  if (i.nrps) claims[LTI.nrps] = { context_memberships_url: i.nrps.membershipsUrl, service_versions: ["2.0"] };
  return claims;
}

// ─── Deep Linking response ──────────────────────────────────────────────────

export type DeepLinkSelection = {
  url: string | null;
  title: string | null;
  custom: Record<string, string>;
  scoreMaximum: number | null;
  openInNewWindow: boolean;
};

/**
 * Reads a verified LtiDeepLinkingResponse: checks the message type, version, deployment and the
 * echoed `data`, then returns the first ltiResourceLink item. `null` means the teacher picked nothing.
 */
export function parseDeepLinkingResponse(
  payload: Record<string, unknown>,
  expected: { deploymentId: string; data: string },
): { selection: DeepLinkSelection | null; message: string | null } {
  if (payload[LTI.messageType] !== "LtiDeepLinkingResponse") throw new Error("Not a Deep Linking response");
  if (payload[LTI.version] !== "1.3.0") throw new Error("Unsupported LTI version");
  if (payload[LTI.deploymentId] !== expected.deploymentId) throw new Error("Unknown deployment");
  if (payload[LTI.dlData] !== expected.data) throw new Error("The response does not belong to this request");
  const error = payload[LTI.dlErrorMessage];
  if (typeof error === "string" && error) throw new Error(`The tool reported an error: ${error.slice(0, 300)}`);
  const msg = payload[LTI.dlMessage];
  const message = typeof msg === "string" && msg ? msg.slice(0, 500) : null;

  const items = Array.isArray(payload[LTI.contentItems]) ? (payload[LTI.contentItems] as Record<string, unknown>[]) : [];
  const link = items.find((x) => x && typeof x === "object" && x.type === "ltiResourceLink");
  if (!link) return { selection: null, message };

  const url = typeof link.url === "string" && /^https?:\/\//i.test(link.url) ? link.url.slice(0, 2000) : null;
  const custom: Record<string, string> = {};
  if (link.custom && typeof link.custom === "object") {
    for (const [k, v] of Object.entries(link.custom as Record<string, unknown>).slice(0, 50)) {
      if (CUSTOM_KEY.test(k) && (typeof v === "string" || typeof v === "number" || typeof v === "boolean")) custom[k] = String(v).slice(0, 4000);
    }
  }
  const lineItem = link.lineItem as { scoreMaximum?: unknown } | undefined;
  const max = typeof lineItem?.scoreMaximum === "number" && lineItem.scoreMaximum > 0 ? Math.min(lineItem.scoreMaximum, 10_000) : null;
  const target = (link.window ? "window" : (link.iframe ? "iframe" : null)) ?? (link.presentation as { documentTarget?: string } | undefined)?.documentTarget;
  return {
    selection: {
      url,
      title: typeof link.title === "string" && link.title.trim() ? link.title.trim().slice(0, 255) : null,
      custom,
      scoreMaximum: max,
      openInNewWindow: target === "window",
    },
    message,
  };
}

function stripTags(html: string) {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

// ─── AGS score ──────────────────────────────────────────────────────────────

export const ACTIVITY_PROGRESS = ["Initialized", "Started", "InProgress", "Submitted", "Completed"] as const;
export const GRADING_PROGRESS = ["FullyGraded", "Pending", "PendingManual", "Failed", "NotReady"] as const;

export type ScoreInput = {
  scoreGiven?: number | null;
  scoreMaximum?: number | null;
  activityProgress: (typeof ACTIVITY_PROGRESS)[number];
  gradingProgress: (typeof GRADING_PROGRESS)[number];
};

/**
 * What a score means for the gradebook:
 *  - `skip`: not final (gradingProgress ≠ FullyGraded) → the gradebook is not touched;
 *  - `clear`: FullyGraded without scoreGiven → grade removed;
 *  - `set`: FullyGraded with a score → scaled to the activity's gradeMax.
 */
export function scoreToGrade(s: ScoreInput, gradeMax: number): { kind: "skip" } | { kind: "clear" } | { kind: "set"; rawGrade: number } {
  if (s.gradingProgress !== "FullyGraded") return { kind: "skip" };
  if (s.scoreGiven === undefined || s.scoreGiven === null) return { kind: "clear" };
  if (!s.scoreMaximum || s.scoreMaximum <= 0) throw new Error("scoreMaximum must be positive when scoreGiven is present");
  if (s.scoreGiven < 0) throw new Error("scoreGiven must not be negative");
  // Extra credit (scoreGiven > scoreMaximum) is allowed by AGS; the gradebook clamps to gradeMax.
  const raw = (s.scoreGiven / s.scoreMaximum) * gradeMax;
  return { kind: "set", rawGrade: Math.round(raw * 100_000) / 100_000 };
}

export const isSubmission = (p: ScoreInput["activityProgress"]) => p === "Completed" || p === "Submitted";

// ─── HTML (auto-submitting forms) ───────────────────────────────────────────

export function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * A page that immediately submits a form (nonce-protected inline script, with a
 * visible button as no-JS fallback). Every value is HTML-escaped.
 */
export function autoSubmitPage(input: { action: string; method: "GET" | "POST"; fields: Record<string, string>; title: string; button: string; nonce: string }) {
  const inputs = Object.entries(input.fields)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="origin">
<title>${escapeHtml(input.title)}</title>
<style>body{font-family:system-ui,sans-serif;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;color:#444}button{font:inherit;padding:8px 16px}</style>
</head>
<body>
<form id="f" method="${input.method === "GET" ? "get" : "post"}" action="${escapeHtml(input.action)}">
${inputs}
<noscript><button type="submit">${escapeHtml(input.button)}</button></noscript>
</form>
<p id="m">${escapeHtml(input.title)}…</p>
<script nonce="${escapeHtml(input.nonce)}">document.getElementById("f").submit();</script>
</body>
</html>`;
}

export function errorPage(message: string) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Launch error</title>
<style>body{font-family:system-ui,sans-serif;margin:24px;color:#444}h1{font-size:18px;color:#b91c1c}</style></head>
<body><h1>The external tool could not be launched</h1><p>${escapeHtml(message)}</p></body></html>`;
}

/** CSP for our auto-submit pages: only the nonce'd script runs; forms may target the tool. */
export function formPageCsp(nonce: string, allowHttp: boolean) {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    // Chrome applies form-action to redirects that follow the submission (tool login → our /lti/auth).
    `form-action 'self' https:${allowHttp ? " http:" : ""}`,
    "frame-ancestors 'self'",
    "base-uri 'none'",
  ].join("; ");
}

/** Parses an application/x-www-form-urlencoded body into a flat object (last value wins). */
export function parseForm(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(body)) out[k] = v;
  return out;
}
