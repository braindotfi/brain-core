import Fastify, { type FastifyInstance } from "fastify";
import {
  authPlugin,
  errorHandlerPlugin,
  idempotencyPlugin,
  requestIdPlugin,
  type IdempotencyStore,
  type JwtVerifier,
} from "@brain/shared";
import { registerAuditRoutes } from "./routes.js";
import type { AuditDeps } from "./deps.js";

export interface BuildAuditAppOptions {
  deps: AuditDeps;
  jwtVerifier: JwtVerifier;
  idempotencyStore: IdempotencyStore;
  idempotencyTtlSeconds?: number;
  logger?: ReturnType<typeof Fastify>["log"];
}

export async function buildAuditApp(opts: BuildAuditAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? { level: process.env.LOG_LEVEL ?? "info" },
    bodyLimit: 512 * 1024,
  });
  await app.register(requestIdPlugin);
  await app.register(errorHandlerPlugin);
  await app.register(authPlugin, { verifier: opts.jwtVerifier });
  await app.register(idempotencyPlugin, {
    store: opts.idempotencyStore,
    ttlSeconds: opts.idempotencyTtlSeconds ?? 86400,
  });

  app.get("/health", { config: { skipAuth: true } }, async () => ({ ok: true }));

  await registerAuditRoutes(app, opts.deps);
  return app;
}
