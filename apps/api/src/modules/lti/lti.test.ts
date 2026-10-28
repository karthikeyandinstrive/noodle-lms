import { describe, expect, it } from "vitest";
import {
  autoSubmitPage,
  buildLaunchClaims,
  checkAuthRequest,
  LTI,
  parseCustomParams,
  parseForm,
  ROLES,
  rolesFor,
  rolesForArchetypes,
  SCOPES,
  scoreToGrade,
  substituteCustom,
  type LaunchInput,
} from "./claims";
import { publishedKeys, RETIRED_KEY_GRACE_MS } from "./keys";
import { bearerOf, claimJti, issueAccessToken, verifyAccessToken } from "./service";

const tool = { clientId: "client-1", redirectUris: ["https://tool.example/launch"] };
const goodAuth = {
  scope: "openid",
  response_type: "id_token",
  response_mode: "form_post",
  prompt: "none",
  client_id: "client-1",
  redirect_uri: "https://tool.example/launch",
  login_hint: "user-1",
  lti_message_hint: "hint",
  state: "s",
  nonce: "n",
};

describe("OIDC authentication request", () => {
  it("accepts a valid request", () => {
    expect(checkAuthRequest(goodAuth, tool)).toBeNull();
  });

  it.each([
    [{ response_type: "code" }, /response_type/],
    [{ scope: "profile" }, /openid/],
    [{ response_mode: "query" }, /response_mode/],
    [{ prompt: "login" }, /prompt/],
    [{ nonce: undefined }, /nonce/],
    [{ client_id: "other" }, /client_id/],
    [{ redirect_uri: "https://evil.example/" }, /redirect_uri/],
    [{ login_hint: undefined }, /login_hint/],
  ])("rejects %o", (patch, error) => {
    expect(checkAuthRequest({ ...goodAuth, ...patch }, tool)).toMatch(error);
  });
});

const launch: LaunchInput = {
  issuer: "https://lms.example",
  clientId: "client-1",
  deploymentId: "dep-1",
  nonce: "nonce-1",
  now: 1_700_000_000_000,
  user: { id: "u1", firstName: "Ada", lastName: "Lovelace", email: "ada@example.com", locale: "en" },
  sharePersonalData: true,
  roles: [ROLES.learner],
  activity: { id: "a1", name: "Quiz tool", description: "<p>Hello <b>world</b></p>" },
  course: { id: "c1", shortname: "ALG", fullname: "Algebra" },
  targetLinkUri: "https://tool.example/launch",
  documentTarget: "iframe",
  returnUrl: "https://lms.example/activities/a1",
  custom: { level: "3" },
  platform: { guid: "org-1", name: "Org" },
  ags: { scopes: [SCOPES.lineItemReadonly, SCOPES.score], lineItemUrl: "https://lms.example/li", lineItemsUrl: "https://lms.example/lis" },
  nrps: { membershipsUrl: "https://lms.example/m" },
};

describe("id_token claims", () => {
  it("builds an LtiResourceLinkRequest", () => {
    const c = buildLaunchClaims(launch);
    expect(c).toMatchObject({ iss: "https://lms.example", aud: "client-1", sub: "u1", nonce: "nonce-1", iat: 1_700_000_000, exp: 1_700_000_300 });
    expect(c[LTI.messageType]).toBe("LtiResourceLinkRequest");
    expect(c[LTI.version]).toBe("1.3.0");
    expect(c[LTI.deploymentId]).toBe("dep-1");
    expect(c[LTI.resourceLink]).toEqual({ id: "a1", title: "Quiz tool", description: "Hello world" });
    expect(c[LTI.context]).toEqual({ id: "c1", label: "ALG", title: "Algebra", type: ["http://purl.imsglobal.org/vocab/lis/v2/course#CourseOffering"] });
    expect(c[LTI.launchPresentation]).toMatchObject({ document_target: "iframe", return_url: "https://lms.example/activities/a1" });
    expect(c[LTI.custom]).toEqual({ level: "3" });
    expect(c[LTI.ags]).toEqual({ scope: [SCOPES.lineItemReadonly, SCOPES.score], lineitem: "https://lms.example/li", lineitems: "https://lms.example/lis" });
    expect(c[LTI.nrps]).toEqual({ context_memberships_url: "https://lms.example/m", service_versions: ["2.0"] });
    expect(c).toMatchObject({ name: "Ada Lovelace", given_name: "Ada", family_name: "Lovelace", email: "ada@example.com" });
  });

  it("omits personal data, AGS and NRPS when not enabled", () => {
    const c = buildLaunchClaims({ ...launch, sharePersonalData: false, ags: null, nrps: null, custom: {} });
    for (const k of ["name", "given_name", "family_name", "email", LTI.ags, LTI.nrps, LTI.custom]) expect(c).not.toHaveProperty([k]);
  });

  it("maps roles", () => {
    expect(rolesFor({ canEdit: false, canGrade: false, isSiteAdmin: false })).toEqual([ROLES.learner]);
    expect(rolesFor({ canEdit: true, canGrade: true, isSiteAdmin: false })).toEqual([ROLES.instructor]);
    expect(rolesFor({ canEdit: false, canGrade: false, isSiteAdmin: true })).toContain(ROLES.institutionAdmin);
    expect(rolesForArchetypes(["student"])).toEqual([ROLES.learner]);
    expect(rolesForArchetypes(["teacher", "editing_teacher"])).toEqual([ROLES.instructor]);
    expect(rolesForArchetypes([])).toEqual([]);
  });
});

describe("custom parameters", () => {
  it("parses key=value lines", () => {
    expect(parseCustomParams("a=1\n\n# comment\n b.c = x=y \r\nuser=$User.id")).toEqual({ a: "1", "b.c": "x=y", user: "$User.id" });
    expect(() => parseCustomParams("novalue")).toThrow();
    expect(() => parseCustomParams("bad key=1")).toThrow();
  });

  it("substitutes supported variables only", () => {
    expect(substituteCustom({ u: "$User.id", x: "$Unknown.var", y: "plain" }, { "$User.id": "u1" })).toEqual({ u: "u1", x: "$Unknown.var", y: "plain" });
  });
});

describe("AGS scores", () => {
  it("scales FullyGraded scores to the activity's maximum", () => {
    expect(scoreToGrade({ scoreGiven: 8, scoreMaximum: 10, activityProgress: "Completed", gradingProgress: "FullyGraded" }, 50)).toEqual({ kind: "set", rawGrade: 40 });
    expect(scoreToGrade({ activityProgress: "Completed", gradingProgress: "FullyGraded" }, 50)).toEqual({ kind: "clear" });
    expect(scoreToGrade({ scoreGiven: 8, scoreMaximum: 10, activityProgress: "Submitted", gradingProgress: "Pending" }, 50)).toEqual({ kind: "skip" });
    expect(() => scoreToGrade({ scoreGiven: 8, activityProgress: "Completed", gradingProgress: "FullyGraded" }, 50)).toThrow();
  });
});

describe("HTML forms", () => {
  it("escapes every value", () => {
    const html = autoSubmitPage({
      action: 'https://tool.example/"><script>alert(1)</script>',
      method: "POST",
      fields: { state: `"><img src=x onerror=alert(1)>`, "a<b": "&" },
      title: "<t>",
      button: "Go",
      nonce: "abc",
    });
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img");
    expect(html).toContain("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain('name="a&lt;b" value="&amp;"');
    expect(html).toContain('<script nonce="abc">');
  });

  it("parses urlencoded bodies", () => {
    expect(parseForm("a=1&b=x%20y&b=z")).toEqual({ a: "1", b: "z" });
  });
});

describe("service access tokens", () => {
  it("round-trips and rejects tampering or expiry", () => {
    const t = issueAccessToken({ organizationId: "o", toolId: "t", clientId: "c", scopes: [SCOPES.score] });
    expect(verifyAccessToken(t)).toMatchObject({ o: "o", t: "t", s: [SCOPES.score] });
    const [p, body, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ o: "o", t: "t", c: "c", s: [SCOPES.memberships], e: 9e9 })).toString("base64url");
    expect(verifyAccessToken(`${p}.${forged}.${sig}`)).toBeNull();
    expect(verifyAccessToken(`${p}.${body}.x${sig}`)).toBeNull();
    expect(verifyAccessToken(t, Date.now() + 2 * 3600_000)).toBeNull();
    expect(verifyAccessToken(undefined)).toBeNull();
    expect(bearerOf(`Bearer ${t}`)).toBe(t);
    expect(bearerOf("Basic x")).toBeUndefined();
  });

  it("allows a client assertion jti only once", async () => {
    expect(await claimJti("client:jti-1", 60)).toBe(true);
    expect(await claimJti("client:jti-1", 60)).toBe(false);
    expect(await claimJti("client:jti-2", 60)).toBe(true);
  });
});

describe("key rotation", () => {
  it("keeps retired keys published for 7 days after their successor", () => {
    const now = Date.now();
    const at = (msAgo: number) => new Date(now - msAgo);
    const rows = [
      { id: "k3", active: true, createdAt: at(1000) },
      { id: "k2", active: false, createdAt: at(RETIRED_KEY_GRACE_MS + 5000) },
      { id: "k1", active: false, createdAt: at(RETIRED_KEY_GRACE_MS * 3) },
    ];
    expect(publishedKeys(rows, now).map((k) => k.id)).toEqual(["k3", "k2"]);
    const old = [
      { id: "k3", active: true, createdAt: at(RETIRED_KEY_GRACE_MS + 1) },
      { id: "k2", active: false, createdAt: at(RETIRED_KEY_GRACE_MS * 2) },
    ];
    expect(publishedKeys(old, now).map((k) => k.id)).toEqual(["k3"]);
  });
});
