/**
 * Ledger service Fastify app factory.
 *
 * Exported as a function so tests can spin up an app with injected fakes.
 * Boot wiring (HTTP port, DB pool, audit emitter) lives alongside infra
 * config in stage-8.
 */

import Fastify, { type FastifyInstance } from "fastify";
import {
  authPlugin,
  errorHandlerPlugin,
  requestIdPlugin,
  type JwtVerifier,
} from "@brain/api/shared";
import { LedgerService } from "./service/LedgerService.js";
import { registerLedgerRoutes } from "./routes/index.js";
import type { LedgerDeps } from "./deps.js";

export interface BuildLedgerAppOptions {
  deps: LedgerDeps;
  jwtVerifier: JwtVerifier;
  logger?: ReturnType<typeof Fastify>["log"];
}

export async function buildLedgerApp(opts: BuildLedgerAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? { level: process.env.LOG_LEVEL ?? "info" },
    bodyLimit: 1 * 1024 * 1024,
  });
  await app.register(requestIdPlugin);
  await app.register(errorHandlerPlugin);
  await app.register(authPlugin, { verifier: opts.jwtVerifier });

  app.get("/health", { config: { skipAuth: true } }, async () => ({ ok: true }));

  const service = new LedgerService(opts.deps);
  await registerLedgerRoutes(app, service);
  return app;
}
