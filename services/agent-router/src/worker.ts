/**
 * Event-driven routing worker.
 *
 * Consumes routing jobs off the `agentRoute` queue: route the event to an
 * agent, then propose through the existing path. The worker never executes.
 *
 * `routeAndPropose` is the testable orchestration; `createAgentRouteWorker`
 * is the thin BullMQ wrapper wired at boot.
 */

import type { Worker } from "bullmq";
import {
  createWorker,
  QUEUE_NAMES,
  type BrainJobEnvelope,
  type RoutingJobPayload,
  type ServiceCallContext,
} from "@brain/shared";
import type { AgentRouter } from "./router.js";
import type { EvidenceGatherer } from "./evidence-gatherer.js";
import { proposeAction, type InternalAgentHandler, type ProposeDeps } from "./agents/handler.js";
import type { RoutingInput } from "./types.js";

export interface RouteAndProposeDeps {
  readonly router: AgentRouter;
  readonly handlers: Readonly<Record<string, InternalAgentHandler>>;
  readonly evidence: EvidenceGatherer;
  readonly propose: ProposeDeps;
}

export interface RouteAndProposeResult {
  readonly selected_agent_id: string | null;
  readonly proposed?: { id: string; status: string; policy_decision_id: string | null };
  readonly reason: string;
}

export async function routeAndPropose(
  ctx: ServiceCallContext,
  input: RoutingInput,
  deps: RouteAndProposeDeps,
): Promise<RouteAndProposeResult> {
  const decision = await deps.router.route(ctx, input);
  if (decision.selected_agent_id === null) {
    return { selected_agent_id: null, reason: decision.reason };
  }
  const handler = deps.handlers[decision.selected_agent_id];
  if (handler === undefined) {
    return {
      selected_agent_id: decision.selected_agent_id,
      reason: "no handler for selected agent",
    };
  }
  // Phase 1: default to the agent's first action. A finer event→action map
  // lands with the embedding classifier in Phase 4.
  const action = handler.actions[0];
  if (action === undefined) {
    return { selected_agent_id: decision.selected_agent_id, reason: "agent declares no actions" };
  }
  const bundle = await deps.evidence.gather({
    tenantId: ctx.tenantId,
    ...(input.context !== undefined ? { context: input.context } : {}),
    requiredEvidence: [],
  });
  const proposed = handler.build({
    action,
    context: input.context ?? {},
    evidence: bundle,
  });
  const result = await proposeAction(proposed, ctx, decision.selected_agent_id, deps.propose);
  return {
    selected_agent_id: decision.selected_agent_id,
    proposed: result,
    reason: decision.reason,
  };
}

export interface AgentRouteWorkerDeps extends RouteAndProposeDeps {
  readonly redisUrl: string;
  /** Principal id the worker acts as (e.g. a system agent id). */
  readonly actor: string;
  readonly concurrency?: number;
}

export function createAgentRouteWorker(
  deps: AgentRouteWorkerDeps,
): Worker<BrainJobEnvelope<RoutingJobPayload>, RouteAndProposeResult> {
  return createWorker<RoutingJobPayload, RouteAndProposeResult>(
    QUEUE_NAMES.agentRoute,
    async (job) => {
      const env = job.data;
      const ctx: ServiceCallContext = {
        tenantId: env.tenantId,
        actor: deps.actor,
        ...(env.requestId !== undefined ? { requestId: env.requestId } : {}),
      };
      const input: RoutingInput = {
        tenant_id: env.tenantId,
        event: env.payload.event,
        ...(env.payload.context !== undefined ? { context: env.payload.context } : {}),
      };
      return routeAndPropose(ctx, input, deps);
    },
    {
      redisUrl: deps.redisUrl,
      ...(deps.concurrency !== undefined ? { concurrency: deps.concurrency } : {}),
    },
  );
}
