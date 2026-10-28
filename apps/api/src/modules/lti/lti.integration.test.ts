import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify, SignJWT, type CryptoKey } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * End-to-end LTI 1.3 flow against the in-process API (in-memory PGlite).
 * A local HTTP server plays the tool's JWKS endpoint, so private addresses are allowed here.
 */
process.env.ALLOW_PRIVATE_STORAGE_ENDPOINTS = "true";

type Helpers = typeof import("../../../test/helpers");
let h: Helpers;
let env: Awaited<ReturnType<Helpers["setup"]>>;
let admin: InstanceType<Helpers["Client"]>;
let student: InstanceType<Helpers["Client"]>;
let studentId: string;
let courseId: string;
let activityId: string;
let tool: { id: string; clientId: string; deploymentId: string };
let toolKey: CryptoKey;
let jwksServer: Server;
let toolBase: string;

const hidden = (html: string, name: string) => new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1]?.replace(/&amp;/g, "&");

async function inject(method: "GET" | "POST", url: string, opts: { cookie?: string; headers?: Record<string, string>; payload?: string } = {}) {
  return env.app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { host: "localhost", ...(opts.cookie ? { cookie: opts.cookie } : {}), ...opts.headers },
    ...(opts.payload !== undefined ? { payload: opts.payload } : {}),
  });
}

async function startLaunch() {
  const res = await inject("GET", `/lti/${activityId}/launch`, { cookie: student.cookie });
  expect(res.statusCode).toBe(200);
  expect(res.headers["content-type"]).toContain("text/html");
  expect(res.headers["content-security-policy"]).toContain("script-src 'nonce-");
  return { hint: hidden(res.body, "lti_message_hint")!, loginHint: hidden(res.body, "login_hint")!, iss: hidden(res.body, "iss")! };
}

const authParams = (hint: string, loginHint: string) =>
  new URLSearchParams({
    scope: "openid",
    response_type: "id_token",
    response_mode: "form_post",
    prompt: "none",
    client_id: tool.clientId,
    redirect_uri: `${toolBase}/launch`,
    login_hint: loginHint,
    lti_message_hint: hint,
    state: "state-<1>",
    nonce: "nonce-1",
  });

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  toolKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "tool-1", alg: "RS256", use: "sig" };
  jwksServer = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((r) => jwksServer.listen(0, "127.0.0.1", r));
  toolBase = `http://127.0.0.1:${(jwksServer.address() as AddressInfo).port}`;

  h = await import("../../../test/helpers");
  env = await h.setup();
  admin = new h.Client(env.app);
  expect((await admin.login("admin@default.test")).status).toBe(200);
  const created = await admin.req("POST", "/users", { email: "lti-student@default.test", firstName: "Lia", lastName: "Learner", password: h.PASSWORD });
  studentId = created.body.id;
  student = new h.Client(env.app);
  expect((await student.login("lti-student@default.test")).status).toBe(200);
  const course = await admin.req("POST", "/courses", { fullname: "Tools 101", shortname: "TL101", selfEnrol: "open" });
  courseId = course.body.id;
  expect((await student.req("POST", `/courses/${courseId}/enrol`, {})).status).toBe(200);
});

afterAll(async () => {
  await env?.app.close();
  jwksServer?.close();
  const { closeDb } = await import("@lms/db");
  await closeDb();
});

describe("LTI 1.3 platform", () => {
  it("registers a tool (admin only) and exposes the platform configuration", async () => {
    const body = { name: "Test tool", loginUrl: `${toolBase}/login`, launchUrl: `${toolBase}/launch`, jwksUrl: `${toolBase}/jwks` };
    expect((await student.req("POST", "/lti/tools", body)).status).toBe(403);
    const res = await admin.req("POST", "/lti/tools", body);
    expect(res.status).toBe(201);
    tool = res.body;
    expect(res.body.redirectUris).toEqual([`${toolBase}/launch`]);
    expect(res.body.clientId).toBeTruthy();
    const cfg = await admin.req("GET", `/lti/tools/${tool.id}/config`);
    expect(cfg.body).toMatchObject({
      issuer: "http://localhost:3000",
      clientId: tool.clientId,
      deploymentId: tool.deploymentId,
      authLoginUrl: "http://localhost:3000/api/v1/lti/auth",
      accessTokenUrl: "http://localhost:3000/api/v1/lti/token",
      jwksUrl: `http://localhost:3000/api/v1/lti/jwks/${env.orgs.default!.id}`,
    });
    expect((await student.req("GET", "/lti/tools/available")).body.map((t: { id: string }) => t.id)).toContain(tool.id);
  });

  it("creates a graded LTI activity", async () => {
    const overview = await admin.req("GET", `/courses/${courseId}`);
    const res = await admin.req("POST", `/courses/${courseId}/activities`, {
      type: "lti",
      sectionId: overview.body.sections[0].id,
      name: "External quiz",
      settings: { toolId: tool.id, customParams: { who: "$User.id" }, gradeMax: 10 },
    });
    expect(res.status).toBe(201);
    activityId = res.body.id;
    expect(res.body.settings).toMatchObject({ toolId: tool.id, gradeMax: 10, toolName: "Test tool" });
  });

  it("runs the OIDC launch and signs a verifiable id_token", async () => {
    const { hint, loginHint, iss } = await startLaunch();
    expect(loginHint).toBe(studentId);
    expect(iss).toBe("http://localhost:3000");
    const res = await inject("GET", `/lti/auth?${authParams(hint, loginHint)}`, { cookie: student.cookie });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`action="${toolBase}/launch"`);
    expect(hidden(res.body, "state")).toBe("state-&lt;1&gt;");
    const idToken = hidden(res.body, "id_token")!;

    const keys = (await inject("GET", `/lti/jwks/${env.orgs.default!.id}`)).json();
    const { payload, protectedHeader } = await jwtVerify(idToken, createLocalJWKSet(keys), { issuer: "http://localhost:3000", audience: tool.clientId });
    expect(protectedHeader.kid).toBeTruthy();
    expect(payload.sub).toBe(studentId);
    expect(payload.nonce).toBe("nonce-1");
    expect(payload["https://purl.imsglobal.org/spec/lti/claim/roles"]).toEqual(["http://purl.imsglobal.org/vocab/lis/v2/membership#Learner"]);
    expect(payload["https://purl.imsglobal.org/spec/lti/claim/custom"]).toEqual({ who: studentId });
    expect(payload["https://purl.imsglobal.org/spec/lti/claim/context"]).toMatchObject({ id: courseId, label: "TL101" });
    expect(payload["https://purl.imsglobal.org/spec/lti-ags/claim/endpoint"]).toMatchObject({ lineitem: `http://localhost:3000/api/v1/lti/ags/${activityId}/lineitem` });
    expect(payload.email).toBe("lti-student@default.test");

    // Single use.
    const again = await inject("GET", `/lti/auth?${authParams(hint, loginHint)}`, { cookie: student.cookie });
    expect(again.statusCode).toBe(400);
  });

  it("rejects a mismatched session, redirect_uri or login_hint", async () => {
    const a = await startLaunch();
    expect((await inject("GET", `/lti/auth?${authParams(a.hint, a.loginHint)}`, { cookie: admin.cookie })).statusCode).toBe(400);
    const b = await startLaunch();
    const p = authParams(b.hint, b.loginHint);
    p.set("redirect_uri", "https://evil.example/cb");
    expect((await inject("GET", `/lti/auth?${p}`)).body).toContain("redirect_uri");
    const c = await startLaunch();
    expect((await inject("GET", `/lti/auth?${authParams(c.hint, "someone-else")}`)).statusCode).toBe(400);
  });

  it("accepts a cross-site form POST without the session cookie (single-use hint)", async () => {
    const { hint, loginHint } = await startLaunch();
    const res = await inject("POST", "/lti/auth", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: authParams(hint, loginHint).toString(),
    });
    expect(res.statusCode).toBe(200);
    expect(hidden(res.body, "id_token")).toBeTruthy();
  });

  const assertion = (jti: string, aud = "http://localhost:3000/api/v1/lti/token") =>
    new SignJWT({ jti })
      .setProtectedHeader({ alg: "RS256", kid: "tool-1" })
      .setIssuer(tool.clientId)
      .setSubject(tool.clientId)
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(toolKey);

  const tokenRequest = async (clientAssertion: string, scope: string) =>
    inject("POST", "/lti/token", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "client_credentials",
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: clientAssertion,
        scope,
      }).toString(),
    });

  let accessToken: string;

  it("issues service tokens for a valid client assertion only once", async () => {
    const scope = "https://purl.imsglobal.org/spec/lti-ags/scope/score https://purl.imsglobal.org/spec/lti-ags/scope/lineitem.readonly https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly";
    const signed = await assertion("jti-1");
    const res = await tokenRequest(signed, scope);
    expect(res.statusCode).toBe(200);
    accessToken = res.json().access_token;
    expect(res.json().scope.split(" ")).toHaveLength(3);
    expect((await tokenRequest(signed, scope)).statusCode).toBe(401);
    expect((await tokenRequest(await assertion("jti-2", "https://other.example/token"), scope)).json().error).toBe("invalid_client");
  });

  it("serves the line item and records scores in the gradebook", async () => {
    const auth = { authorization: `Bearer ${accessToken}` };
    const li = await inject("GET", `/lti/ags/${activityId}/lineitem`, { headers: auth });
    expect(li.statusCode).toBe(200);
    expect(li.headers["content-type"]).toContain("application/vnd.ims.lis.v2.lineitem+json");
    expect(li.json()).toMatchObject({ scoreMaximum: 10, resourceLinkId: activityId });
    expect((await inject("GET", `/lti/ags/${activityId}/lineitem`)).statusCode).toBe(401);

    const score = (body: Record<string, unknown>) =>
      inject("POST", `/lti/ags/${activityId}/lineitem/scores`, {
        headers: { ...auth, "content-type": "application/vnd.ims.lis.v1.score+json" },
        payload: JSON.stringify(body),
      });
    const res = await score({ userId: studentId, scoreGiven: 4, scoreMaximum: 5, activityProgress: "Completed", gradingProgress: "FullyGraded", timestamp: new Date().toISOString() });
    expect(res.statusCode).toBe(204);
    const stale = await score({ userId: studentId, scoreGiven: 1, scoreMaximum: 5, activityProgress: "Completed", gradingProgress: "FullyGraded", timestamp: "2000-01-01T00:00:00Z" });
    expect(stale.statusCode).toBe(409);
    const stranger = await score({ userId: crypto.randomUUID(), scoreGiven: 1, scoreMaximum: 5, activityProgress: "Completed", gradingProgress: "FullyGraded", timestamp: new Date().toISOString() });
    expect(stranger.statusCode).toBe(400);

    const { systemDb, gradeGrades, gradeItems } = await import("@lms/db");
    const { eq } = await import("drizzle-orm");
    const db = await systemDb();
    const [row] = await db.select({ g: gradeGrades.finalGrade }).from(gradeGrades).innerJoin(gradeItems, eq(gradeItems.id, gradeGrades.itemId)).where(eq(gradeItems.activityId, activityId));
    expect(row?.g).toBe(8);
  });

  it("lists course memberships (NRPS)", async () => {
    const res = await inject("GET", `/lti/nrps/${activityId}/memberships`, { headers: { authorization: `Bearer ${accessToken}` } });
    expect(res.statusCode).toBe(200);
    const members = res.json().members as { user_id: string; roles: string[]; email?: string }[];
    expect(members.find((m) => m.user_id === studentId)).toMatchObject({ roles: ["http://purl.imsglobal.org/vocab/lis/v2/membership#Learner"], email: "lti-student@default.test" });
  });

  it("rotates keys and keeps the previous key published", async () => {
    const before = (await inject("GET", `/lti/jwks/${env.orgs.default!.id}`)).json().keys.length;
    expect((await admin.req("POST", "/lti/keys/rotate", {})).status).toBe(200);
    const after = (await inject("GET", `/lti/jwks/${env.orgs.default!.id}`)).json().keys;
    expect(after.length).toBe(before + 1);
    expect(after.every((k: Record<string, unknown>) => !("d" in k))).toBe(true);
  });

  it("refuses to delete a tool in use", async () => {
    expect((await admin.req("DELETE", `/lti/tools/${tool.id}`)).status).toBe(409);
  });
});

describe("LTI Deep Linking and line item management", () => {
  const DL = "https://purl.imsglobal.org/spec/lti-dl/claim/";
  const LTI_CLAIM = "https://purl.imsglobal.org/spec/lti/claim/";

  /** Runs the teacher's Deep Linking launch up to the signed request; returns its claims. */
  async function deepLinkRequest() {
    const start = await inject("GET", `/lti/${activityId}/deep-link`, { cookie: admin.cookie });
    expect(start.statusCode).toBe(200);
    const hint = hidden(start.body, "lti_message_hint")!;
    const loginHint = hidden(start.body, "login_hint")!;
    const res = await inject("GET", `/lti/auth?${authParams(hint, loginHint)}`, { cookie: admin.cookie });
    expect(res.statusCode).toBe(200);
    const keys = (await inject("GET", `/lti/jwks/${env.orgs.default!.id}`)).json();
    const { payload } = await jwtVerify(hidden(res.body, "id_token")!, createLocalJWKSet(keys), { issuer: "http://localhost:3000", audience: tool.clientId });
    return payload;
  }

  const response = (claims: Record<string, unknown>) =>
    new SignJWT({
      [`${LTI_CLAIM}message_type`]: "LtiDeepLinkingResponse",
      [`${LTI_CLAIM}version`]: "1.3.0",
      [`${LTI_CLAIM}deployment_id`]: tool.deploymentId,
      nonce: "dl-nonce",
      ...claims,
    })
      .setProtectedHeader({ alg: "RS256", kid: "tool-1" })
      .setIssuer(tool.clientId)
      .setAudience("http://localhost:3000")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(toolKey);

  const postBack = async (jwt: string) =>
    inject("POST", "/lti/deep-link/return", { headers: { "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams({ JWT: jwt }).toString() });

  it("only editors can start content selection", async () => {
    expect((await inject("GET", `/lti/${activityId}/deep-link`, { cookie: student.cookie })).statusCode).toBeGreaterThanOrEqual(403);
  });

  it("sends a Deep Linking request and saves the selected link", async () => {
    const req = await deepLinkRequest();
    expect(req[`${LTI_CLAIM}message_type`]).toBe("LtiDeepLinkingRequest");
    expect(req[`${LTI_CLAIM}resource_link`]).toBeUndefined();
    const settings = req[`${DL}deep_linking_settings`] as { deep_link_return_url: string; data: string; accept_types: string[] };
    expect(settings).toMatchObject({ deep_link_return_url: "http://localhost:3000/api/v1/lti/deep-link/return", accept_types: ["ltiResourceLink"] });

    const jwt = await response({
      [`${DL}data`]: settings.data,
      [`${DL}content_items`]: [
        { type: "ltiResourceLink", title: "Chapter 3 quiz", url: `${toolBase}/launch/quiz-3`, custom: { quiz: "3" }, lineItem: { scoreMaximum: 25, label: "Chapter 3 quiz" }, window: { targetName: "_blank" } },
      ],
    });
    const res = await postBack(jwt);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).toContain(`/activities/${activityId}/edit`);

    const activity = await admin.req("GET", `/activities/${activityId}`);
    expect(activity.body.name).toBe("Chapter 3 quiz");
    expect(activity.body.settings).toMatchObject({ targetLinkUri: `${toolBase}/launch/quiz-3`, customParams: { quiz: "3" }, gradeMax: 25, openInNewWindow: true });

    // Single use.
    expect((await postBack(jwt)).body).toContain("already saved");
  });

  it("rejects responses that don't match a request or aren't signed by the tool", async () => {
    const forged = await response({ [`${DL}data`]: "not-a-request", [`${DL}content_items`]: [] });
    expect((await postBack(forged)).statusCode).toBe(400);
    const req = await deepLinkRequest();
    const data = (req[`${DL}deep_linking_settings`] as { data: string }).data;
    const wrongAudience = await new SignJWT({ [`${LTI_CLAIM}message_type`]: "LtiDeepLinkingResponse", [`${DL}data`]: data })
      .setProtectedHeader({ alg: "RS256", kid: "tool-1" })
      .setIssuer(tool.clientId)
      .setAudience("https://elsewhere.example")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(toolKey);
    expect((await postBack(wrongAudience)).body).toContain("could not be verified");
  });

  it("lets the tool update its line item with the lineitem scope", async () => {
    const signed = await new SignJWT({ jti: "jti-lineitem" })
      .setProtectedHeader({ alg: "RS256", kid: "tool-1" })
      .setIssuer(tool.clientId)
      .setSubject(tool.clientId)
      .setAudience("http://localhost:3000/api/v1/lti/token")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(toolKey);
    const tokenRes = await inject("POST", "/lti/token", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "client_credentials",
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: signed,
        scope: "https://purl.imsglobal.org/spec/lti-ags/scope/lineitem",
      }).toString(),
    });
    expect(tokenRes.statusCode).toBe(200);
    const auth = { authorization: `Bearer ${tokenRes.json().access_token}`, "content-type": "application/vnd.ims.lis.v2.lineitem+json" };
    const put = await inject("POST", `/lti/ags/${activityId}/lineitems`, { headers: auth, payload: JSON.stringify({ scoreMaximum: 40, label: "Quiz" }) });
    expect(put.statusCode).toBe(409); // one line item per link, already created
    const upd = await env.app.inject({ method: "PUT", url: `/api/v1/lti/ags/${activityId}/lineitem`, headers: { host: "localhost", ...auth }, payload: JSON.stringify({ scoreMaximum: 40, label: "Quiz" }) });
    expect(upd.statusCode, upd.body).toBe(200);
    expect(upd.json()).toMatchObject({ scoreMaximum: 40 });
    expect((await admin.req("GET", `/activities/${activityId}`)).body.settings.gradeMax).toBe(40);
  });

  it("returns gradebook results with the result.readonly scope", async () => {
    const signed = await new SignJWT({ jti: "jti-results" })
      .setProtectedHeader({ alg: "RS256", kid: "tool-1" })
      .setIssuer(tool.clientId)
      .setSubject(tool.clientId)
      .setAudience("http://localhost:3000/api/v1/lti/token")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(toolKey);
    const tokenRes = await inject("POST", "/lti/token", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "client_credentials",
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: signed,
        scope: "https://purl.imsglobal.org/spec/lti-ags/scope/result.readonly",
      }).toString(),
    });
    expect(tokenRes.statusCode, tokenRes.body).toBe(200);
    const headers = { authorization: `Bearer ${tokenRes.json().access_token}` };
    const res = await inject("GET", `/lti/ags/${activityId}/lineitem/results?user_id=${studentId}`, { headers });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["content-type"]).toContain("application/vnd.ims.lis.v2.resultcontainer+json");
    const [result] = res.json();
    expect(result).toMatchObject({ userId: studentId, scoreOf: `http://localhost:3000/api/v1/lti/ags/${activityId}/lineitem`, resultMaximum: 40 });
    expect(typeof result.resultScore).toBe("number");
    // The score token can't read results.
    expect((await inject("GET", `/lti/ags/${activityId}/lineitem/results`)).statusCode).toBe(401);
  });
});

describe("course-level tools", () => {
  it("lets a course's teachers register tools that only that course can use", async () => {
    const created = await admin.req("POST", "/users", { email: "lti-teacher@default.test", firstName: "Tess", lastName: "Teacher", password: h.PASSWORD });
    expect((await admin.req("POST", `/courses/${courseId}/enrolments`, { userIds: [created.body.id], role: "editing_teacher" })).status).toBe(200);
    const teacher = new h.Client(env.app);
    expect((await teacher.login("lti-teacher@default.test")).status).toBe(200);

    const body = { name: "Course tool", loginUrl: `${toolBase}/login`, launchUrl: `${toolBase}/launch`, jwksUrl: `${toolBase}/jwks`, courseId };
    // Students can't, and teachers can't register organization-wide tools.
    expect((await student.req("POST", "/lti/tools", body)).status).toBe(403);
    expect((await teacher.req("POST", "/lti/tools", { ...body, courseId: undefined })).status).toBe(403);
    const res = await teacher.req("POST", "/lti/tools", body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.courseId).toBe(courseId);
    const courseTool = res.body.id as string;

    expect((await teacher.req("GET", `/lti/tools?courseId=${courseId}`)).body.map((x: { id: string }) => x.id)).toEqual([courseTool]);
    expect((await admin.req("GET", "/lti/tools")).body.map((x: { id: string }) => x.id)).not.toContain(courseTool);
    expect((await teacher.req("GET", `/lti/tools/available?courseId=${courseId}`)).body.map((x: { id: string }) => x.id)).toContain(courseTool);
    expect((await teacher.req("GET", `/lti/tools/${courseTool}/config`)).status).toBe(200);

    const sectionId = (await admin.req("GET", `/courses/${courseId}`)).body.sections[0].id;
    expect((await teacher.req("POST", `/courses/${courseId}/activities`, { type: "lti", sectionId, name: "Course tool link", settings: { toolId: courseTool } })).status).toBe(201);

    // Another course can't see or use it.
    const other = await admin.req("POST", "/courses", { fullname: "Other", shortname: "OTH" });
    const otherSection = (await admin.req("GET", `/courses/${other.body.id}`)).body.sections[0].id;
    expect((await admin.req("GET", `/lti/tools/available?courseId=${other.body.id}`)).body.map((x: { id: string }) => x.id)).not.toContain(courseTool);
    expect((await admin.req("POST", `/courses/${other.body.id}/activities`, { type: "lti", sectionId: otherSection, name: "x", settings: { toolId: courseTool } })).status).toBe(400);
    // Nor can someone without the capability in that course manage it.
    expect((await student.req("PATCH", `/lti/tools/${courseTool}`, { enabled: false })).status).toBe(404);
  });
});
