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
import { ReconciliationService } from "./reconciliation/ReconciliationService.js";
import { registerLedgerRoutes } from "./routes/index.js";
import { registerCashFlowRoutes } from "./cash_flows/routes.js";
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

  const ledger = new LedgerService(opts.deps);
  const reconciliation = new ReconciliationService({
    pool: opts.deps.pool,
    audit: opts.deps.audit,
  });
  await registerLedgerRoutes(app, ledger, reconciliation);
  await registerCashFlowRoutes(app, ledger);
  return app;
}

/**
 * Plugin-style registration for the composed single-process boot.
 *
 * Registers all Ledger routes on an already-configured Fastify app (shared
 * plugins registered once by main.ts). No standalone server setup.
 */
export async function registerLedgerPlugin(app: FastifyInstance, deps: LedgerDeps): Promise<void> {
  const service = new LedgerService(deps);
  const reconciliation = new ReconciliationService({ pool: deps.pool, audit: deps.audit });
  await registerLedgerRoutes(app, service, reconciliation);
  await registerCashFlowRoutes(app, service);
}
