import { eq, or } from "drizzle-orm";
import fp from "fastify-plugin";
import { organizations, systemDb, withTenant } from "@lms/db";
import { config } from "../config";
import { notFound } from "./errors";
import { cache } from "./redis";
import type { Org } from "./types";

const TTL_SECONDS = 60;

/** Maps a host to its organization: custom domain → <slug>.BASE_DOMAIN → DEFAULT_ORG_SLUG. */
export async function resolveOrg(host: string): Promise<Org | null> {
  const hostname = host.split(":")[0]!.toLowerCase();
  const cacheKey = `org:host:${hostname}`;
  const cached = await cache.get(cacheKey);
  if (cached) return JSON.parse(cached) as Org;

  const suffix = `.${config.BASE_DOMAIN}`;
  const slug = hostname.endsWith(suffix) ? hostname.slice(0, -suffix.length) : config.DEFAULT_ORG_SLUG;

  const db = await systemDb();
  const [row] = await db
    .select()
    .from(organizations)
    .where(or(eq(organizations.customDomain, hostname), eq(organizations.slug, slug)))
    .orderBy(organizations.customDomain)
    .limit(1);
  if (!row || row.status !== "active") return null;

  const org: Org = { id: row.id, slug: row.slug, name: row.name, plan: row.plan, settings: row.settings };
  await cache.set(cacheKey, JSON.stringify(org), TTL_SECONDS);
  return org;
}

export const tenantPlugin = fp(async (app) => {
  app.decorateRequest("org", null as unknown as Org);
  app.decorateRequest("tenant", function <T>(this: { org: Org }, fn: Parameters<typeof withTenant<T>>[1]) {
    return withTenant(this.org.id, fn);
  });

  app.addHook("onRequest", async (req) => {
    if (req.routeOptions.config?.tenant === false) return;
    // Behind the Next.js proxy the original host arrives in X-Forwarded-Host (honoured when TRUST_PROXY).
    const org = await resolveOrg(req.host);
    if (!org) throw notFound("Organization");
    req.org = org;
  });
});
