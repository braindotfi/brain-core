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
  type IAgentService,
  type RoutingJobPayload,
  type ServiceCallContext,
} from "@brain/shared";
import type { InternalAgentDefinition } from "@brain/schemas";
import type { AgentRouter } from "./router.js";
import type { EvidenceGatherer } from "./evidence-gatherer.js";
import type { ActionResolver } from "./action-resolver.js";
import {
  proposeAction,
  validateAgentPayload,
  type InternalAgentHandler,
  type ProposeDeps,
  type ProposedAction,
} from "@brain/internal-agents";
import type { RoutingInput } from "./types.js";

export interface RouteAndProposeDeps {
  readonly router: AgentRouter;
  readonly handlers: Readonly<Record<string, InternalAgentHandler>>;
  /** Selected-agent definitions keyed by agent_key (for action resolution). */
  readonly definitions: Readonly<Record<string, InternalAgentDefinition>>;
  /** Picks the action within the selected agent (replaces handler.actions[0]). */
  readonly actionResolver: ActionResolver;
  readonly evidence: EvidenceGatherer;
  readonly propose: ProposeDeps;
  /**
   * True when the agent must not move money yet (shadow-by-default). REQUIRED —
   * the event/BullMQ path must enforce the SAME LIVE_AGENTS shadow gate as
   * `/agents/run` (AgentRunService). A financial proposal from a shadowed agent
   * is NOT created — it terminates as `shadow_completed`. Wired from the
   * graduated PromotionPolicy at the composition root.
   */
  readonly isShadowed: (agentId: string) => boolean;
  /**
   * Graduated-rollout rail allowlist (1b): for a LIVE agent's financial
   * proposal, returns false if the action's rail is not on the agent's
   * allowlist — the proposal is held in shadow rather than created. Absent ⇒ no
   * rail restriction (only `isShadowed` gates). Mirrors AgentRunService.
   */
  readonly checkRail?: (agentId: string, actionType: string) => boolean;
  /**
   * Per-agent IAgentService overrides. A non-financial proposal for an agent
   * listed here is routed to that IAgentService instead of `propose.agents`,
   * letting an agent delegate to an external reasoning service.
   *
   * The reconciliation agent uses this to delegate to the Python reconciliation
   * agent: bind `{ reconciliation: new ReconciliationAgentClient(url) }` at the
   * composition root (ReconciliationAgentClient is itself an IAgentService whose
   * propose() POSTs to the Python agent, which reasons then proposes back).
   * Financial (payment_intent) proposals are unaffected — they always go through
   * `propose.paymentIntents`.
   */
  readonly agentOverrides?: Readonly<Record<string, IAgentService>>;
}

export interface RouteAndProposeResult {
  readonly selected_agent_id: string | null;
  /** Resolved action within the selected agent, when one was resolved. */
  readonly action?: string;
  /** Run status: no_match/unscoped (routing) or missing_action (resolution) or proposed. */
  readonly status?: string;
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
    return {
      selected_agent_id: null,
      status: decision.policy_status,
      reason: decision.reason,
    };
  }
  const handler = deps.handlers[decision.selected_agent_id];
  if (handler === undefined) {
    return {
      selected_agent_id: decision.selected_agent_id,
      status: "missing_handler",
      reason: "no handler for selected agent",
    };
  }
  const definition = deps.definitions[decision.selected_agent_id];
  if (definition === undefined) {
    return {
      selected_agent_id: decision.selected_agent_id,
      status: "missing_handler",
      reason: "no definition for selected agent",
    };
  }
  // Resolve the action WITHIN the selected agent. Never silently fall back to
  // handler.actions[0]: an unresolved action persists as missing_action.
  const resolution = await deps.actionResolver.resolve({
    definition,
    actions: handler.actions,
    ...(input.event !== undefined ? { event: input.event } : {}),
    ...(input.intent !== undefined ? { intent: input.intent } : {}),
    ...(input.context !== undefined ? { context: input.context } : {}),
  });
  if (resolution.status === "missing_action") {
    return {
      selected_agent_id: decision.selected_agent_id,
      status: "missing_action",
      reason: resolution.reason,
    };
  }
  const action = resolution.action;
  const bundle = await deps.evidence.gather({
    tenantId: ctx.tenantId,
    ...(input.context !== undefined ? { context: input.context } : {}),
    requiredEvidence: definition.required_evidence,
  });

  const shadowed = deps.isShadowed(decision.selected_agent_id);
  let proposed: ProposedAction | undefined;
  if (shadowed) {
    try {
      proposed = handler.build({
        action,
        context: input.context ?? {},
        evidence: bundle,
        definition,
        confidence: decision.confidence,
      });
    } catch (err) {
      return {
        selected_agent_id: decision.selected_agent_id,
        action,
        status: "failed",
        reason: `payload_invalid:${handlerBuildErrorReason(err)}`,
      };
    }
    if (proposed.channel === "payment_intent") {
      return {
        selected_agent_id: decision.selected_agent_id,
        action,
        status: "shadow_completed",
        reason: "agent_shadowed",
      };
    }
  }

  if (bundle.critical_missing) {
    return {
      selected_agent_id: decision.selected_agent_id,
      action,
      status: "missing_evidence",
      reason: `critical_missing_evidence:${bundle.missing_required_evidence.join(",")}`,
    };
  }

  if (decision.execution_mode === "reject" || decision.execution_mode === "notify_only") {
    return {
      selected_agent_id: decision.selected_agent_id,
      action,
      status: decision.execution_mode === "reject" ? "rejected" : "notify_only",
      reason: `execution_mode_${decision.execution_mode}`,
    };
  }

  if (proposed === undefined) {
    try {
      proposed = handler.build({
        action,
        context: input.context ?? {},
        evidence: bundle,
        definition,
        confidence: decision.confidence,
      });
    } catch (err) {
      return {
        selected_agent_id: decision.selected_agent_id,
        action,
        status: "failed",
        reason: `payload_invalid:${handlerBuildErrorReason(err)}`,
      };
    }
  }
  if (proposed.channel === "agent") {
    const validation = validateAgentPayload(decision.selected_agent_id, proposed.action);
    if (!validation.ok) {
      return {
        selected_agent_id: decision.selected_agent_id,
        action,
        status: "failed",
        reason: `payload_invalid:${validation.missing.join(",")}`,
      };
    }
  }

  // SHADOW GATE (parity with AgentRunService /agents/run): a financial proposal
  // moves no money — and is NOT created — when the agent is shadowed, OR
  // (graduated rollout) when it's live but the action's rail is not allowlisted.
  // Without this, the event/BullMQ path could create a PaymentIntent row for a
  // shadowed agent (the §6 gate would still block execution, but the row should
  // never exist). The proposal terminates as shadow_completed.
  if (proposed.channel === "payment_intent") {
    const railBlocked =
      !shadowed &&
      deps.checkRail !== undefined &&
      !deps.checkRail(decision.selected_agent_id, proposed.intent.action_type);
    if (shadowed || railBlocked) {
      return {
        selected_agent_id: decision.selected_agent_id,
        action,
        status: "shadow_completed",
        reason: shadowed ? "agent_shadowed" : "rail_not_allowlisted",
      };
    }
  }

  // Delegate to a per-agent IAgentService when one is bound (e.g. reconciliation
  // → Python agent). Only affects the agent (non-financial) channel; financial
  // proposals always use propose.paymentIntents.
  const override = deps.agentOverrides?.[decision.selected_agent_id];
  const proposeDeps: ProposeDeps =
    override !== undefined
      ? { agents: override, paymentIntents: deps.propose.paymentIntents }
      : deps.propose;
  const result = await proposeAction(proposed, ctx, decision.selected_agent_id, proposeDeps);
  return {
    selected_agent_id: decision.selected_agent_id,
    action,
    status: "proposal_created",
    proposed: result,
    reason: decision.reason,
  };
}

function handlerBuildErrorReason(err: unknown): string {
  if (err instanceof Error && err.message.trim().length > 0) {
    return err.message.trim();
  }
  return "handler_build_failed";
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
