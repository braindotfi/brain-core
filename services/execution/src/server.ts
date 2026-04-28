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
  /**
   * Optional MCP wiring hook. The boot site constructs a
   * BrainMcpServer (from `@brain/mcp`) and passes a function that
   * registers it on the Fastify app. We accept a callback rather than
   * the BrainMcpServer directly so services/execution stays unaware of
   * the MCP module — that avoids a workspace cycle (mcp depends on
   * execution for PaymentIntentService).
   *
   * Typical wiring:
   *
   *   import { BrainMcpServer, registerMcpRoute } from "@brain/mcp";
   *   const mcp = new BrainMcpServer({ ... });
   *   const app = await buildExecutionApp({
   *     deps,
   *     jwtVerifier,
   *     registerMcp: (a) => registerMcpRoute(a, mcp),
   *   });
   */
  registerMcp?: (app: FastifyInstance) => Promise<void>;
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

  // Stage-6 routes: /execution/* (proposals, executions, agents, legacy /execution/mcp ping stub).
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

  // Feature/mcp-server: optional MCP route registration. When supplied,
  // the boot site has constructed a BrainMcpServer (from @brain/mcp) and
  // is asking us to mount it at /agents/mcp on this same Fastify
  // instance. When omitted, /agents/mcp returns 404 — the legacy
  // /execution/mcp ping stub still answers.
  if (opts.registerMcp !== undefined) {
    await opts.registerMcp(app);
  }

  return app;
}
