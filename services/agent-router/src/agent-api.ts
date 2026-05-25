/**
 * Unified /v1/agents/* API surface (plan 1a.6). Mounts on the execution Fastify
 * app via the registerAgentRouter hook; the /v1 prefix comes from the mount.
 *
 * Internal and external agents share these routes — kind/provenance is a
 * metadata field, never a route (no /v1/agents/native/*).
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  brainError,
  requireScope,
  type AgentRunEvidenceItem,
  type AgentRunGateTrace,
  type Scope,
  type ServiceCallContext,
} from "@brain/shared";
import type { InternalAgentDefinition } from "@brain/schemas";
import type { AgentRouter } from "./router.js";
import type { AgentRunService } from "./agent-run-service.js";
import type { RoutingInput } from "./types.js";
import { toAgentRunSummary, toAgentRunWhy } from "./agent-run-views.js";

const SCOPE_READ: Scope = "execution:read";
const SCOPE_PROPOSE: Scope = "payment_intent:propose";
// Kill-switch (1b.3) is high-privilege. Approve scope is the closest existing
// gate; tenant-root / break-glass mapping is a follow-up.
const SCOPE_HALT: Scope = "payment_intent:approve";

function assertCtx(request: FastifyRequest): ServiceCallContext {
  if (request.principal === undefined) {
    throw brainError("auth_token_missing", "principal required");
  }
  return {
    tenantId: request.principal.tenantId,
    actor: request.principal.id,
    requestId: request.id,
    principalType: request.principal.type,
    scopes: request.principal.scopes,
  };
}

/** Read side of the agent-run persistence used by the GET endpoints. */
export interface AgentApiReadStore {
  listRuns(
    ctx: ServiceCallContext,
    filter: { agentId?: string; status?: string; category?: string; limit?: number },
  ): Promise<unknown[]>;
  findRun(ctx: ServiceCallContext, id: string): Promise<unknown | null>;
  findRoutingDecision(ctx: ServiceCallContext, id: string): Promise<unknown | null>;
}

export interface AgentApiDeps {
  readonly catalog: () => readonly InternalAgentDefinition[];
  readonly router: AgentRouter;
  readonly runService: AgentRunService;
  readonly reads: AgentApiReadStore;
  /** Enqueue an event-driven route/run job. Returns the job id. */
  readonly enqueueRouteJob: (
    ctx: ServiceCallContext,
    payload: { event?: string; intent?: string; context?: Record<string, unknown> },
  ) => Promise<{ jobId: string }>;
  /**
   * Kill-switch (1b.3): pause all in-flight intents from an agent and quarantine
   * the agent record. Returns the paused intent ids + whether the agent was
   * quarantined.
   */
  readonly haltAgent: (
    ctx: ServiceCallContext,
    agentId: string,
  ) => Promise<{ paused: string[]; quarantined: boolean }>;
  /**
   * H-09: release an agent's contribution quarantine (operator action). Returns
   * false when the agent is not visible to the tenant (→ 404). Injected from the
   * composition root (the agents table lives in @brain/execution).
   */
  readonly releaseAgentQuarantine?: (ctx: ServiceCallContext, agentId: string) => Promise<boolean>;
  /**
   * H-25 Agent Run History loaders. Cross-cutting reads (evidence chain, the §6
   * gate trace via the run's action, the H-07 proof, the routing decision +
   * behavior hash) are injected from the composition root (services/api), since
   * they span the Audit/Ledger schemas + the Proof builder that @brain/agent-router
   * must not import directly. When absent the sub-resources report unavailable.
   */
  readonly runHistory?: {
    evidenceCount(ctx: ServiceCallContext, runId: string): Promise<number>;
    evidence(ctx: ServiceCallContext, runId: string): Promise<AgentRunEvidenceItem[] | null>;
    gateTrace(ctx: ServiceCallContext, runId: string): Promise<AgentRunGateTrace | null>;
    proof(ctx: ServiceCallContext, runId: string): Promise<unknown | null>;
    behaviorHash(ctx: ServiceCallContext, runId: string): Promise<string | null>;
    routingDecisionForRun(ctx: ServiceCallContext, runId: string): Promise<unknown | null>;
  };
}

interface RunBody {
  event?: string;
  intent?: string;
  context?: Record<string, unknown>;
}

function toRoutingInput(ctx: ServiceCallContext, body: RunBody): RoutingInput {
  if (body.event === undefined && body.intent === undefined) {
    throw brainError("request_body_invalid", "one of `event` or `intent` is required");
  }
  return {
    tenant_id: ctx.tenantId,
    ...(body.event !== undefined ? { event: body.event } : {}),
    ...(body.intent !== undefined ? { intent: body.intent } : {}),
    ...(body.context !== undefined ? { context: body.context } : {}),
  };
}

export async function registerAgentApiRoutes(
  app: FastifyInstance,
  deps: AgentApiDeps,
): Promise<void> {
  // GET /v1/agents — list (filter: kind, capability, category, state).
  app.get(
    "/agents",
    async (
      request: FastifyRequest<{
        Querystring: { kind?: string; capability?: string; category?: string; state?: string };
      }>,
    ) => {
      const ctx = assertCtx(request);
      requireScope(ctx.scopes ?? [], SCOPE_READ);
      const q = request.query;
      const agents = deps.catalog().filter((d) => {
        if (q.kind !== undefined && d.provenance !== q.kind) return false;
        if (q.capability !== undefined && !d.capabilities.includes(q.capability)) return false;
        if (q.category !== undefined && d.category !== q.category) return false;
        if (q.state === "enabled" && !d.enabled_by_default) return false;
        if (q.state === "disabled" && d.enabled_by_default) return false;
        return true;
      });
      return { agents };
    },
  );

  // GET /v1/agents/{agent_id} — config + on-chain registration record.
  app.get(
    "/agents/:agent_id",
    async (request: FastifyRequest<{ Params: { agent_id: string } }>) => {
      const ctx = assertCtx(request);
      requireScope(ctx.scopes ?? [], SCOPE_READ);
      const def = deps.catalog().find((d) => d.agent_key === request.params.agent_id);
      if (def === undefined) {
        throw brainError("agent_not_found", `agent ${request.params.agent_id} not found`);
      }
      // TODO(agent-autonomy-v3): join the on-chain BrainMCPAgentRegistry record
      // (scopeHash, execution address, ScopeAttestation) once a reader is wired.
      return { definition: def, registration: null };
    },
  );

  // POST /v1/agents/route — routing decision only (no run).
  app.post("/agents/route", async (request: FastifyRequest<{ Body: RunBody }>) => {
    const ctx = assertCtx(request);
    requireScope(ctx.scopes ?? [], SCOPE_READ);
    return deps.router.route(ctx, toRoutingInput(ctx, request.body ?? {}));
  });

  // POST /v1/agents/run — route, resolve action, persist run, propose safely.
  app.post("/agents/run", async (request: FastifyRequest<{ Body: RunBody }>) => {
    const ctx = assertCtx(request);
    requireScope(ctx.scopes ?? [], SCOPE_PROPOSE);
    return deps.runService.run(ctx, toRoutingInput(ctx, request.body ?? {}));
  });

  // POST /v1/agents/events — enqueue an event-driven route/run job.
  app.post("/agents/events", async (request: FastifyRequest<{ Body: RunBody }>) => {
    const ctx = assertCtx(request);
    requireScope(ctx.scopes ?? [], SCOPE_PROPOSE);
    const body = request.body ?? {};
    if (body.event === undefined && body.intent === undefined) {
      throw brainError("request_body_invalid", "one of `event` or `intent` is required");
    }
    const { jobId } = await deps.enqueueRouteJob(ctx, {
      ...(body.event !== undefined ? { event: body.event } : {}),
      ...(body.intent !== undefined ? { intent: body.intent } : {}),
      ...(body.context !== undefined ? { context: body.context } : {}),
    });
    return { job_id: jobId, status: "queued" };
  });

  // POST /v1/agents/{agent_id}/halt — pause all in-flight intents + quarantine.
  app.post(
    "/agents/:agent_id/halt",
    async (request: FastifyRequest<{ Params: { agent_id: string } }>) => {
      const ctx = assertCtx(request);
      requireScope(ctx.scopes ?? [], SCOPE_HALT);
      const result = await deps.haltAgent(ctx, request.params.agent_id);
      return { agent_id: request.params.agent_id, ...result };
    },
  );

  // POST /v1/agents/{agent_id}/quarantine/release — clear the contribution
  // quarantine so subsequent agent contributions extract normally (H-09).
  app.post(
    "/agents/:agent_id/quarantine/release",
    { config: { idempotent: true } },
    async (request: FastifyRequest<{ Params: { agent_id: string } }>) => {
      const ctx = assertCtx(request);
      requireScope(ctx.scopes ?? [], SCOPE_HALT);
      const agentId = request.params.agent_id;
      const released = deps.releaseAgentQuarantine
        ? await deps.releaseAgentQuarantine(ctx, agentId)
        : false;
      if (!released) {
        throw brainError("execution_agent_not_registered", `no such agent ${agentId}`, {
          statusOverride: 404,
        });
      }
      return { agent_id: agentId, quarantine_released: true };
    },
  );

  // POST /v1/agents/halt-category — emergency-stop every agent in a category.
  app.post(
    "/agents/halt-category",
    async (request: FastifyRequest<{ Body: { category?: string } }>) => {
      const ctx = assertCtx(request);
      requireScope(ctx.scopes ?? [], SCOPE_HALT);
      const category = request.body?.category;
      if (category !== "business" && category !== "consumer" && category !== "agnostic") {
        throw brainError("request_body_invalid", "`category` must be business|consumer|agnostic");
      }
      const agentIds = deps
        .catalog()
        .filter((d) => d.category === category)
        .map((d) => d.agent_key);
      const halted: Array<{ agent_id: string; paused: string[]; quarantined: boolean }> = [];
      for (const agentId of agentIds) {
        const result = await deps.haltAgent(ctx, agentId);
        halted.push({ agent_id: agentId, ...result });
      }
      return { category, halted };
    },
  );

  // GET /v1/agents/runs — list runs (filter: agent_id, status, category).
  app.get(
    "/agents/runs",
    async (
      request: FastifyRequest<{
        Querystring: { agent_id?: string; status?: string; category?: string; limit?: string };
      }>,
    ) => {
      const ctx = assertCtx(request);
      requireScope(ctx.scopes ?? [], SCOPE_READ);
      const q = request.query;
      const runs = await deps.reads.listRuns(ctx, {
        ...(q.agent_id !== undefined ? { agentId: q.agent_id } : {}),
        ...(q.status !== undefined ? { status: q.status } : {}),
        ...(q.category !== undefined ? { category: q.category } : {}),
        ...(q.limit !== undefined ? { limit: Number(q.limit) } : {}),
      });
      return { runs };
    },
  );

  // GET /v1/agents/runs/{run_id} — run summary (H-25 flagship trust artifact).
  app.get(
    "/agents/runs/:run_id",
    async (request: FastifyRequest<{ Params: { run_id: string } }>) => {
      const ctx = assertCtx(request);
      requireScope(ctx.scopes ?? [], SCOPE_READ);
      const runId = request.params.run_id;
      const run = (await deps.reads.findRun(ctx, runId)) as Record<string, unknown> | null;
      if (run === null) {
        throw brainError("agent_run_not_found", `run ${runId} not found`);
      }
      const evidenceCount = deps.runHistory ? await deps.runHistory.evidenceCount(ctx, runId) : 0;
      return toAgentRunSummary(run, { evidenceCount });
    },
  );

  // GET /v1/agents/runs/{run_id}/why — which agents were candidates + why this
  // one was selected (router multi-factor reason) + the runtime behavior hash.
  app.get(
    "/agents/runs/:run_id/why",
    async (request: FastifyRequest<{ Params: { run_id: string } }>) => {
      const ctx = assertCtx(request);
      requireScope(ctx.scopes ?? [], SCOPE_READ);
      const runId = request.params.run_id;
      const run = (await deps.reads.findRun(ctx, runId)) as Record<string, unknown> | null;
      if (run === null) {
        throw brainError("agent_run_not_found", `run ${runId} not found`);
      }
      const routingDecision = deps.runHistory
        ? ((await deps.runHistory.routingDecisionForRun(ctx, runId)) as Record<
            string,
            unknown
          > | null)
        : null;
      const behaviorHash = deps.runHistory ? await deps.runHistory.behaviorHash(ctx, runId) : null;
      return toAgentRunWhy(run, routingDecision, behaviorHash);
    },
  );

  // GET /v1/agents/runs/{run_id}/evidence — the evidence chain the agent consumed.
  app.get(
    "/agents/runs/:run_id/evidence",
    async (request: FastifyRequest<{ Params: { run_id: string } }>) => {
      const ctx = assertCtx(request);
      requireScope(ctx.scopes ?? [], SCOPE_READ);
      const runId = request.params.run_id;
      const evidence = deps.runHistory ? await deps.runHistory.evidence(ctx, runId) : null;
      if (evidence === null) {
        throw brainError("agent_run_not_found", `run ${runId} not found`);
      }
      return { run_id: runId, evidence };
    },
  );

  // GET /v1/agents/runs/{run_id}/gate-trace — the §6 gate_checks if a gate ran.
  app.get(
    "/agents/runs/:run_id/gate-trace",
    async (request: FastifyRequest<{ Params: { run_id: string } }>) => {
      const ctx = assertCtx(request);
      requireScope(ctx.scopes ?? [], SCOPE_READ);
      const runId = request.params.run_id;
      const trace = deps.runHistory ? await deps.runHistory.gateTrace(ctx, runId) : null;
      if (trace === null) {
        throw brainError("agent_run_not_found", `run ${runId} not found`);
      }
      return trace;
    },
  );

  // GET /v1/agents/runs/{run_id}/proof — proxies H-07 if the run produced an action.
  app.get(
    "/agents/runs/:run_id/proof",
    async (request: FastifyRequest<{ Params: { run_id: string } }>) => {
      const ctx = assertCtx(request);
      requireScope(ctx.scopes ?? [], SCOPE_READ);
      const runId = request.params.run_id;
      const proof = deps.runHistory ? await deps.runHistory.proof(ctx, runId) : null;
      if (proof === null) {
        throw brainError("proof_not_found", `no proof for run ${runId}`, { statusOverride: 404 });
      }
      return proof;
    },
  );

  // GET /v1/agents/routing-decisions/{id} — single routing decision detail.
  app.get(
    "/agents/routing-decisions/:id",
    async (request: FastifyRequest<{ Params: { id: string } }>) => {
      const ctx = assertCtx(request);
      requireScope(ctx.scopes ?? [], SCOPE_READ);
      const decision = await deps.reads.findRoutingDecision(ctx, request.params.id);
      if (decision === null) {
        throw brainError("action_not_found", `routing decision ${request.params.id} not found`);
      }
      return decision;
    },
  );
}
