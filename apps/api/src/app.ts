import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import scalar from "@scalar/fastify-api-reference";
import Fastify, { type FastifyError } from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { isCapability } from "@lms/rbac";
import { config } from "./config";
import { authPlugin } from "./core/auth";
import { AppError } from "./core/errors";
import { logger } from "./core/logger";
import { redis } from "./core/redis";
import { tenantPlugin } from "./core/tenant";
import { modules } from "./modules";

export async function buildApp() {
  const app = Fastify({
    loggerInstance: logger,
    trustProxy: config.TRUST_PROXY || !config.isProd,
    bodyLimit: 1024 * 1024,
    genReqId: () => crypto.randomUUID(),
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // ─── Security plugins ──────────────────────────────────────────────────
  await app.register(helmet, {
    // JSON API: the web app sets the page CSP. The docs page needs inline scripts.
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "same-site" },
  });
  await app.register(cors, { origin: config.allowedOrigins, credentials: true });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
    ...(redis ? { redis } : {}),
    keyGenerator: (req) => req.ip,
  });

  // ─── API documentation (OpenAPI 3 generated from Zod schemas) ──────────
  await app.register(swagger, {
    openapi: {
      openapi: "3.0.3",
      info: { title: "LMS API", version: "1.0.0", description: "Moodle-style LMS REST API." },
      servers: [{ url: "/" }],
      components: {
        securitySchemes: {
          cookieAuth: { type: "apiKey", in: "cookie", name: "lms_session" },
          bearerAuth: { type: "http", scheme: "bearer", description: "Session token from POST /api/v1/auth/token" },
        },
      },
      security: [{ cookieAuth: [] }, { bearerAuth: [] }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(scalar, { routePrefix: "/api-docs", configuration: { url: "/openapi.json" } });
  app.get("/openapi.json", { config: { tenant: false }, schema: { hide: true } }, () => app.swagger());

  // ─── Request context ───────────────────────────────────────────────────
  await app.register(tenantPlugin);
  await app.register(authPlugin);

  // ─── Errors ────────────────────────────────────────────────────────────
  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.status(400).send({
        error: { code: "VALIDATION_ERROR", message: "Request validation failed", details: err.validation },
      });
    }
    if (isResponseSerializationError(err)) {
      req.log.error({ err, issues: err.cause.issues }, "response did not match schema");
      return reply.status(500).send({ error: { code: "INTERNAL", message: "Internal server error" } });
    }
    const pgCode = (err as { code?: string; cause?: { code?: string } }).cause?.code ?? (err as { code?: string }).code;
    if (pgCode === "23505") {
      return reply.status(409).send({ error: { code: "CONFLICT", message: "A record with these values already exists" } });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.status(err.statusCode).send({ error: { code: err.code ?? "ERROR", message: err.message } });
    }
    req.log.error({ err }, "unhandled error");
    return reply.status(500).send({ error: { code: "INTERNAL", message: "Internal server error" } });
  });
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: { code: "NOT_FOUND", message: "Route not found" } }));

  // ─── Health ────────────────────────────────────────────────────────────
  app.get("/health", { config: { tenant: false }, schema: { hide: true } }, async () => ({ status: "ok" }));

  // ─── Feature modules (Moodle plugin equivalent) ────────────────────────
  for (const mod of modules) {
    for (const cap of mod.capabilities ?? []) {
      if (!isCapability(cap)) throw new Error(`Module ${mod.name} declares unknown capability ${cap}`);
    }
    await mod.setup?.();
  }
  await app.register(
    async (api) => {
      for (const mod of modules) await api.register(mod.routes, { prefix: mod.basePath === "/" ? "" : mod.basePath });
    },
    { prefix: "/api/v1" },
  );

  return app;
}
