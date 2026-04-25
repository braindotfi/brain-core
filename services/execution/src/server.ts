import Fastify, { type FastifyInstance } from "fastify";
import {
  authPlugin,
  errorHandlerPlugin,
  requestIdPlugin,
  type JwtVerifier,
} from "@brain/api/shared";
import { registerExecutionRoutes } from "./routes.js";
import { ApprovalService } from "./approvals/ApprovalService.js";
import { PaymentIntentService } from "./payment-intents/PaymentIntentService.js";
import { registerPaymentIntentRoutes } from "./payment-intents/routes.js";
import type { ExecutionDeps } from "./deps.js";

export interface BuildExecutionAppOptions {
  deps: ExecutionDeps;
  jwtVerifier: JwtVerifier;
  logger?: ReturnType<typeof Fastify>["log"];
}

export async function buildExecutionApp(opts: BuildExecutionAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? { level: process.env.LOG_LEVEL ?? "info" },
    bodyLimit: 1 * 1024 * 1024,
  });
  await app.register(requestIdPlugin);
  await app.register(errorHandlerPlugin);
  await app.register(authPlugin, { verifier: opts.jwtVerifier });

  app.get("/health", { config: { skipAuth: true } }, async () => ({ ok: true }));

  // Stage-6 routes: /execution/* (proposals, executions, agents, MCP).
  await registerExecutionRoutes(app, opts.deps);

  // Phase-4 routes: /payment-intents/* with the §6 pre-execution gate.
  const approvals = new ApprovalService({
    pool: opts.deps.pool,
    audit: opts.deps.audit,
    resolveRole: opts.deps.resolveRole,
  });
  const paymentIntents = new PaymentIntentService({
    pool: opts.deps.pool,
    audit: opts.deps.audit,
    rails: opts.deps.rails,
    approvals,
    resolveAgent: opts.deps.resolveAgent,
    resolveAccount: opts.deps.resolveAccount,
    resolveCounterparty: opts.deps.resolveCounterparty,
    evaluatePolicy: opts.deps.evaluatePaymentIntent,
    resolvePrincipal: opts.deps.resolvePrincipal,
  });
  await registerPaymentIntentRoutes(app, paymentIntents);

  return app;
}
