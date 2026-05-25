import Fastify, { type FastifyInstance } from "fastify";
import {
  authPlugin,
  errorHandlerPlugin,
  idempotencyPlugin,
  requestIdPlugin,
  type IdempotencyStore,
  type JwtVerifier,
} from "@brain/shared";
import { registerExecutionRoutes } from "./routes.js";
import { registerActionRoutes } from "./actions/routes.js";
import { ApprovalService } from "./approvals/ApprovalService.js";
import { PaymentIntentService } from "./payment-intents/PaymentIntentService.js";
import { registerPaymentIntentRoutes } from "./payment-intents/routes.js";
import { OutboxService } from "./outbox/OutboxService.js";
import type { ExecutionDeps } from "./deps.js";

export interface BuildExecutionAppOptions {
  deps: ExecutionDeps;
  jwtVerifier: JwtVerifier;
  idempotencyStore: IdempotencyStore;
  idempotencyTtlSeconds?: number;
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
  /**
   * Optional agent-router wiring hook, same decoupling rationale as
   * registerMcp. The boot site constructs an AgentRouter (from
   * `@brain/agent-router`) over the internal-agent catalog and passes a
   * function that mounts POST /agents/route. When omitted, the route is
   * absent. services/execution stays unaware of @brain/agent-router (no cycle).
   *
   *   import { AgentRouter, registerAgentRouterRoutes } from "@brain/agent-router";
   *   import { internalAgentCatalog } from "@brain/internal-agents";
   *   const router = new AgentRouter({ catalog: () => internalAgentCatalog, ... });
   *   const app = await buildExecutionApp({
   *     deps, jwtVerifier,
   *     registerAgentRouter: (a) => registerAgentRouterRoutes(a, { router }),
   *   });
   */
  registerAgentRouter?: (app: FastifyInstance) => Promise<void>;
}

export async function buildExecutionApp(opts: BuildExecutionAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? { level: process.env.LOG_LEVEL ?? "info" },
    bodyLimit: 1 * 1024 * 1024,
  });
  await app.register(requestIdPlugin);
  await app.register(errorHandlerPlugin);
  await app.register(authPlugin, { verifier: opts.jwtVerifier });
  await app.register(idempotencyPlugin, {
    store: opts.idempotencyStore,
    ttlSeconds: opts.idempotencyTtlSeconds ?? 86400,
  });

  app.get("/health", { config: { skipAuth: true } }, async () => ({ ok: true }));

  // Stage-6 routes: /execution/* (proposals, executions, agents, legacy /execution/mcp ping stub).
  await registerExecutionRoutes(app, opts.deps);

  // Phase-4 routes: /payment-intents/* with the §6 pre-execution gate.
  const approvals = new ApprovalService({
    pool: opts.deps.pool,
    audit: opts.deps.audit,
    resolveRole: opts.deps.resolveRole,
    ...(opts.deps.isApproverActive !== undefined
      ? { isApproverActive: opts.deps.isApproverActive }
      : {}),
    ...(opts.deps.resolveSubjectOwnerTenant !== undefined
      ? { resolveSubjectOwnerTenant: opts.deps.resolveSubjectOwnerTenant }
      : {}),
    ...(opts.deps.resolveActivePolicyVersion !== undefined
      ? { resolveActivePolicyVersion: opts.deps.resolveActivePolicyVersion }
      : {}),
  });
  // H-04: the HTTP app needs the outbox so `execute` can enqueue the durable
  // dispatch row. The RailRegistry is no longer wired into PaymentIntentService —
  // it lives in the outbox worker process (see startOutboxWorker).
  const outbox = new OutboxService();
  const paymentIntents = new PaymentIntentService({
    pool: opts.deps.pool,
    audit: opts.deps.audit,
    outbox,
    approvals,
    resolveAgent: opts.deps.resolveAgent,
    resolveAccount: opts.deps.resolveAccount,
    resolveCounterparty: opts.deps.resolveCounterparty,
    evaluatePolicy: opts.deps.evaluatePaymentIntent,
    resolvePrincipal: opts.deps.resolvePrincipal,
    ...(opts.deps.resolveTenantFlags !== undefined
      ? { resolveTenantFlags: opts.deps.resolveTenantFlags }
      : {}),
  });
  // Legacy /payment-intents/* routes (deprecated in v0.3) — every reply
  // gets the RFC 8594 `Deprecation: true` header and a `Link` header
  // pointing at the successor /actions/* route. Spec marks each
  // operation with `deprecated: true`.
  app.addHook("onSend", async (request, reply) => {
    if (request.routeOptions?.url?.startsWith("/payment-intents")) {
      reply.header("Deprecation", "true");
      const successor = request.routeOptions.url.replace("/payment-intents", "/actions");
      reply.header("Link", `<${successor}>; rel="successor-version"`);
    }
  });
  await registerPaymentIntentRoutes(app, paymentIntents, opts.deps.resolveInvoiceShortcut);

  // v0.3 canonical /actions/* routes — share the same PaymentIntentService.
  await registerActionRoutes(app, paymentIntents);

  // Feature/mcp-server: optional MCP route registration. When supplied,
  // the boot site has constructed a BrainMcpServer (from @brain/mcp) and
  // is asking us to mount it at /agents/mcp on this same Fastify
  // instance. When omitted, /agents/mcp returns 404 — the legacy
  // /execution/mcp ping stub still answers.
  if (opts.registerMcp !== undefined) {
    await opts.registerMcp(app);
  }

  // Phase 1: optional agent-router route (POST /agents/route → /v1/agents/route).
  if (opts.registerAgentRouter !== undefined) {
    await opts.registerAgentRouter(app);
  }

  return app;
}
