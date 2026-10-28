import { eq } from "drizzle-orm";
import { organizations, type DB } from "@lms/db";
import { config } from "../config";

/**
 * Public, tenant-aware base URLs (no trailing slash) for links that leave the
 * app: certificate verify links and QR codes, Open Badges ids, etc.
 *
 *  - SaaS mode: https://<customDomain> if the organization has one, otherwise
 *    https://<slug>.<BASE_DOMAIN>. Outside production the protocol and port of
 *    APP_URL are kept (e.g. http://acme.localhost:3000), so links work in dev.
 *  - Self-hosted (single site): APP_URL.
 */
export type PublicOrg = { slug: string; customDomain?: string | null };

type UrlConfig = { APP_URL: string; BASE_DOMAIN: string; SAAS_MODE: boolean; isProd: boolean };

export function publicBaseUrlFor(org: PublicOrg, cfg: UrlConfig): string {
  const appUrl = cfg.APP_URL.replace(/\/+$/, "");
  if (!cfg.SAAS_MODE) return appUrl;
  const host = org.customDomain?.trim().toLowerCase() || `${org.slug}.${cfg.BASE_DOMAIN}`;
  if (cfg.isProd) return `https://${host}`;
  const app = new URL(appUrl);
  return `${app.protocol}//${host}${app.port ? `:${app.port}` : ""}`;
}

export function publicBaseUrl(org: PublicOrg): string {
  return publicBaseUrlFor(org, config);
}

/** Loads the organization's slug/custom domain and returns its public base URL. */
export async function publicBaseUrlOf(tx: DB, organizationId: string): Promise<string> {
  const [org] = await tx
    .select({ slug: organizations.slug, customDomain: organizations.customDomain })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return org ? publicBaseUrl(org) : config.APP_URL.replace(/\/+$/, "");
}
