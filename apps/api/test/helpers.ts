import { bootstrapOrganization, runMigrations, systemDb, type DB } from "@lms/db";
import { buildApp } from "../src/app";

type FastifyInstance = Awaited<ReturnType<typeof buildApp>>;

export const PASSWORD = "Password1234";
export const ORIGIN = "http://localhost:3000";

export type TestEnv = { app: FastifyInstance; orgs: Record<string, { id: string; host: string }> };

/** Fresh in-memory database with two organizations, and the API built in-process. */
export async function setup(): Promise<TestEnv> {
  await runMigrations();
  const db = await systemDb();
  const orgs: TestEnv["orgs"] = {};
  for (const [slug, host] of [
    ["default", "localhost"],
    ["acme", "acme.localhost"],
  ] as const) {
    const { organization } = await db.transaction((tx) =>
      bootstrapOrganization(tx as unknown as DB, {
        name: slug,
        slug,
        admin: { email: `admin@${slug}.test`, password: PASSWORD, firstName: "Admin", lastName: slug },
      }),
    );
    orgs[slug] = { id: organization.id, host };
  }
  const app = await buildApp();
  await app.ready();
  return { app, orgs };
}

/** Minimal client that keeps a session cookie per instance. */
export class Client {
  cookie = "";
  constructor(
    private app: FastifyInstance,
    private host = "localhost",
  ) {}

  async req<T = any>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await this.app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { host: this.host, origin: ORIGIN, ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
      ...(body !== undefined ? { payload: body as object } : {}),
    });
    const setCookie = res.headers["set-cookie"];
    if (setCookie) this.cookie = (Array.isArray(setCookie) ? setCookie[0]! : setCookie).split(";")[0]!;
    return { status: res.statusCode, body: (res.body ? JSON.parse(res.body) : undefined) as T };
  }

  login(email: string, password = PASSWORD) {
    return this.req("POST", "/auth/login", { email, password });
  }
}
