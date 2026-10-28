// Shared helpers for the k6 scenarios (k6 runs this, not Node).
import http from "k6/http";
import { check, fail } from "k6";

export const fixture = JSON.parse(open("./.data/fixture.json"));
export const api = (p) => `${fixture.baseUrl}/api/v1${p}`;

/** Bearer token for a user (once per VU; tokens are cached by the caller). */
export function login(email, password) {
  const res = http.post(api("/auth/token"), JSON.stringify({ email, password }), { headers: { "content-type": "application/json" }, tags: { name: "login" } });
  if (!check(res, { "login 200": (r) => r.status === 200 && !!r.json("token") })) fail(`login failed for ${email}: ${res.status}`);
  return res.json("token");
}

export const auth = (token, name) => ({ headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, tags: { name } });
