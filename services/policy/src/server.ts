import Fastify, { type FastifyInstance } from "fastify";
import {
  authPlugin,
  errorHandlerPlugin,
  idempotencyPlugin,
  requestIdPlugin,
  type IdempotencyStore,
  type JwtVerifier,
} from "@brain/api/shared";
import { registerPolicyRoutes } from "./routes.js";
import type { PolicyDeps } from "./deps.js";

export interface BuildPolicyAppOptions {
  deps: PolicyDeps;
  jwtVerifier: JwtVerifier;
  idempotencyStore: IdempotencyStore;
  idempotencyTtlSeconds?: number;
  logger?: ReturnType<typeof Fastify>["log"];
}

export async function buildPolicyApp(opts: BuildPolicyAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? { level: process.env.LOG_LEVEL ?? "info" },
    bodyLimit: 512 * 1024, // policy docs are small
  });
  await app.register(requestIdPlugin);
  await app.register(errorHandlerPlugin);
  await app.register(authPlugin, { verifier: opts.jwtVerifier });
  await app.register(idempotencyPlugin, {
    store: opts.idempotencyStore,
    ttlSeconds: opts.idempotencyTtlSeconds ?? 86400,
  });

  app.get("/health", { config: { skipAuth: true } }, async () => ({ ok: true }));

  await registerPolicyRoutes(app, opts.deps);
  return app;
}
