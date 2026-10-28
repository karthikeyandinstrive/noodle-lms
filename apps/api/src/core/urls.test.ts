import { describe, expect, it } from "vitest";
import { publicBaseUrlFor } from "./urls";

const base = { APP_URL: "http://localhost:3000/", BASE_DOMAIN: "lms.example.com", SAAS_MODE: true, isProd: true };

describe("publicBaseUrlFor", () => {
  it("uses APP_URL in self-hosted mode", () => {
    expect(publicBaseUrlFor({ slug: "acme", customDomain: "learn.acme.com" }, { ...base, SAAS_MODE: false })).toBe("http://localhost:3000");
  });
  it("uses the custom domain, else the tenant subdomain, over https in production", () => {
    expect(publicBaseUrlFor({ slug: "acme", customDomain: "Learn.Acme.com" }, base)).toBe("https://learn.acme.com");
    expect(publicBaseUrlFor({ slug: "acme", customDomain: null }, base)).toBe("https://acme.lms.example.com");
    expect(publicBaseUrlFor({ slug: "acme" }, base)).toBe("https://acme.lms.example.com");
  });
  it("keeps the APP_URL protocol and port outside production", () => {
    expect(publicBaseUrlFor({ slug: "acme" }, { ...base, BASE_DOMAIN: "localhost", isProd: false })).toBe("http://acme.localhost:3000");
  });
});
