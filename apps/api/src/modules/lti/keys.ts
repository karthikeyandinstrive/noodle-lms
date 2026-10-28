import { desc, eq } from "drizzle-orm";
import { exportJWK, exportPKCS8, generateKeyPair, importPKCS8, SignJWT, type CryptoKey, type JWK } from "jose";
import { ltiKeys, type DB } from "@lms/db";
import { decryptSecret, encryptSecret, randomToken } from "../../core/crypto";

/**
 * Platform signing keys (RS256), one active key per organization.
 *
 *  - Generated lazily on first use; the private key is stored as PKCS8 PEM,
 *    AES-GCM encrypted with `encryptSecret` (ENCRYPTION_KEY), never returned by the API.
 *  - Rotation makes a new key active; previous keys stay in the public JWKS for
 *    `RETIRED_KEY_GRACE_MS` after their successor was created, so tools that cached the
 *    JWKS (or id_tokens in flight) keep validating. Older retired keys are pruned on rotation.
 */

export const RETIRED_KEY_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const ALG = "RS256";

type KeyRow = typeof ltiKeys.$inferSelect;

async function createKey(tx: DB, organizationId: string) {
  const { publicKey, privateKey } = await generateKeyPair(ALG, { modulusLength: 2048, extractable: true });
  const kid = randomToken(16);
  const jwk = await exportJWK(publicKey);
  const publicJwk: Record<string, unknown> = { ...jwk, kid, alg: ALG, use: "sig" };
  const pem = await exportPKCS8(privateKey);
  const [row] = await tx
    .insert(ltiKeys)
    .values({ organizationId, kid, publicJwk, privateKeyEnc: encryptSecret(pem), active: true })
    .returning();
  return row!;
}

/** The organization's active signing key (created on first use). */
export async function activeKey(tx: DB, organizationId: string): Promise<KeyRow> {
  const [row] = await tx
    .select()
    .from(ltiKeys)
    .where(eq(ltiKeys.organizationId, organizationId))
    .orderBy(desc(ltiKeys.createdAt))
    .limit(1);
  if (row?.active) return row;
  return createKey(tx, organizationId);
}

/** Retires all current keys and creates a new active one. Prunes keys past the grace period. */
export async function rotateKey(tx: DB, organizationId: string, now = Date.now()) {
  const rows = await tx.select().from(ltiKeys).where(eq(ltiKeys.organizationId, organizationId)).orderBy(desc(ltiKeys.createdAt));
  const keep = new Set(publishedKeys(rows, now).map((k) => k.id));
  for (const r of rows) {
    if (!keep.has(r.id)) await tx.delete(ltiKeys).where(eq(ltiKeys.id, r.id));
    else if (r.active) await tx.update(ltiKeys).set({ active: false }).where(eq(ltiKeys.id, r.id));
  }
  return createKey(tx, organizationId);
}

/**
 * Keys to publish: the active key(s) plus retired keys whose successor was created
 * less than 7 days ago. `rows` must be sorted newest first.
 */
export function publishedKeys<T extends Pick<KeyRow, "active" | "createdAt">>(rows: T[], now = Date.now()): T[] {
  const out: T[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.active) {
      out.push(row);
      continue;
    }
    const successor = rows[i - 1];
    if (successor && now - successor.createdAt.getTime() < RETIRED_KEY_GRACE_MS) out.push(row);
  }
  return out;
}

export async function jwks(tx: DB, organizationId: string): Promise<{ keys: JWK[] }> {
  const rows = await tx.select().from(ltiKeys).where(eq(ltiKeys.organizationId, organizationId)).orderBy(desc(ltiKeys.createdAt));
  return { keys: publishedKeys(rows).map((r) => r.publicJwk as JWK) };
}

const imported = new Map<string, CryptoKey>();

async function privateKeyOf(row: KeyRow) {
  let key = imported.get(row.kid);
  if (!key) {
    key = await importPKCS8(decryptSecret(row.privateKeyEnc), ALG);
    if (imported.size > 500) imported.clear();
    imported.set(row.kid, key);
  }
  return key;
}

/** Signs a JWT with the organization's active key (claims already contain iat/exp). */
export async function signJwt(tx: DB, organizationId: string, claims: Record<string, unknown>) {
  const row = await activeKey(tx, organizationId);
  return new SignJWT(claims).setProtectedHeader({ alg: ALG, kid: row.kid, typ: "JWT" }).sign(await privateKeyOf(row));
}
