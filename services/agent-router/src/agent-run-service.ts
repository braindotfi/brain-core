/**
 * AgentRunService — the orchestration behind POST /v1/agents/run (plan 1a.6).
 *
 * Pipeline: route → resolve action → gather evidence → build proposal →
 * (shadow-aware) propose, persisting an agent_runs row at each terminal state.
 *
 * SHADOW MODE (Phase 1a): a financial proposal (channel "payment_intent") from a
 * shadowed agent is NOT created — the run terminates as shadow_completed. This is
 * how "no native agent moves money in 1a" is enforced at the orchestration layer
 * (the §6 gate enforces it again at execute time). Non-financial proposals
 * (channel "agent") are unaffected, so the read/notify agents (Group D) work.
 *
 * Persistence is injected as an AgentRunStore so this package does not depend on
 * @brain/execution (which would create a workspace cycle); the composition root
 * wires the execution agent_runs repository to the store.
 */

import type {
  ExecutionMode,
  IAgentService,
  ServiceCallContext,
  TenantCategory,
} from "@brain/shared";
import type { AgentPolicyStatus, AgentRunStatus, InternalAgentDefinition } from "@brain/schemas";
import { proposeAction, type InternalAgentHandler, type ProposeDeps } from "@brain/internal-agents";
import type { AgentRouter } from "./router.js";
import type { ActionResolver } from "./action-resolver.js";
import type { EvidenceGatherer } from "./evidence-gatherer.js";
import type { RoutingInput } from "./types.js";

// --- persistence boundary (impl wired at the composition root) -------------

export interface RecordRoutingDecisionInput {
  tenantCategory: string;
  policyStatus: "routed" | "no_match" | "unscoped";
  selectedAgentId: string | null;
  fallbackAgentIds: readonly string[];
  confidence: number | null;
  evidenceScore: number | null;
  reason: Record<string, unknown>;
  eventType?: string | null;
  intent?: string | null;
}

export interface RecordRunInput {
  tenantCategory: string;
  agentId: string;
  agentKind: "internal" | "external";
  executionMode: ExecutionMode;
  status: AgentRunStatus;
  reason: Record<string, unknown>;
  shadowMode: boolean;
  routingDecisionId: string;
  eventType?: string | null;
  intent?: string | null;
  action?: string | null;
  confidence?: number | null;
  evidenceScore?: number | null;
  policyStatus?: AgentPolicyStatus | null;
  proposalId?: string | null;
  paymentIntentId?: string | null;
  failureReason?: string | null;
}

export interface AgentRunStore {
  recordRoutingDecision(
    ctx: ServiceCallContext,
    input: RecordRoutingDecisionInput,
  ): Promise<{ id: string }>;
  recordRun(ctx: ServiceCallContext, input: RecordRunInput): Promise<{ id: string }>;
}

// --- result ----------------------------------------------------------------

export interface AgentRunResult {
  readonly status: AgentRunStatus;
  readonly routing_decision_id: string;
  readonly run_id: string | null;
  readonly selected_agent_id: string | null;
  readonly action: string | null;
  readonly shadow_mode: boolean;
  readonly proposed?: { id: string; status: string; policy_decision_id: string | null };
  readonly reason: Record<string, unknown>;
}

export interface AgentRunServiceDeps {
  readonly router: AgentRouter;
  readonly actionResolver: ActionResolver;
  readonly handlers: Readonly<Record<string, InternalAgentHandler>>;
  readonly definitions: Readonly<Record<string, InternalAgentDefinition>>;
  readonly evidence: EvidenceGatherer;
  readonly propose: ProposeDeps;
  readonly store: AgentRunStore;
  /** Resolve the tenant's category for persistence + routing reasons. */
  readonly getTenantCategory: (tenantId: string) => TenantCategory | Promise<TenantCategory>;
  /**
   * True when the agent must not move money yet. Default (Phase 1a + the 1b
   * pre-promotion state) is true for every agent, so any financial proposal
   * terminates as shadow_completed. Wired from the graduated PromotionPolicy.
   */
  readonly isShadowed: (agentId: string) => boolean;
  /**
   * Graduated-rollout rail allowlist (1b): for a LIVE agent's financial
   * proposal, returns false if the action's rail is not on the agent's
   * allowlist — the proposal is then held in shadow rather than moving money.
   * Absent ⇒ no rail restriction (only `isShadowed` gates).
   */
  readonly checkRail?: (agentId: string, actionType: string) => boolean;
  /** Active intent-classifier strategy, recorded in the structured reason (2.2). */
  readonly intentClassifierStrategy?: "rules" | "embedding";
  /** Per-agent IAgentService overrides (e.g. reconciliation → Python agent). */
  readonly agentOverrides?: Readonly<Record<string, IAgentService>>;
}

export class AgentRunService {
  constructor(private readonly deps: AgentRunServiceDeps) {}

  async run(ctx: ServiceCallContext, input: RoutingInput): Promise<AgentRunResult> {
    const category = await this.deps.getTenantCategory(ctx.tenantId);
    const decision = await this.deps.router.route(ctx, input);

    const reason: Record<string, unknown> = {
      prose: decision.reason,
      trigger: input.event !== undefined ? { kind: "event", value: input.event } : null,
      intent: input.intent ?? null,
      category_match: {
        tenant: category,
        selected: decision.selected_agent_id,
        downgraded: decision.fallback_agent_ids,
      },
      evidence_score: decision.evidence_score,
      intent_classifier: {
        strategy: this.deps.intentClassifierStrategy ?? "rules",
        score: null,
      },
      execution_mode: decision.execution_mode,
      fallback_agents_considered: decision.fallback_agent_ids,
    };

    const routing = await this.deps.store.recordRoutingDecision(ctx, {
      tenantCategory: category,
      policyStatus: decision.policy_status,
      selectedAgentId: decision.selected_agent_id,
      fallbackAgentIds: decision.fallback_agent_ids,
      confidence: decision.confidence,
      evidenceScore: decision.evidence_score,
      reason,
      eventType: input.event ?? null,
      intent: input.intent ?? null,
    });

    if (decision.selected_agent_id === null) {
      // no_match / unscoped — recorded as a routing decision, no run row.
      return {
        status: decision.policy_status,
        routing_decision_id: routing.id,
        run_id: null,
        selected_agent_id: null,
        action: null,
        shadow_mode: false,
        reason,
      };
    }

    const agentId = decision.selected_agent_id;
    const handler = this.deps.handlers[agentId];
    const definition = this.deps.definitions[agentId];
    const executionMode: ExecutionMode = decision.execution_mode ?? "notify_only";

    if (handler === undefined || definition === undefined) {
      return this.terminalRun(ctx, {
        agentId,
        category,
        executionMode,
        status: "missing_handler",
        reason,
        routingDecisionId: routing.id,
        input,
        confidence: decision.confidence,
        failureReason: "no handler/definition for selected agent",
        shadowMode: false,
      });
    }

    const resolution = await this.deps.actionResolver.resolve({
      definition,
      actions: handler.actions,
      tenantId: ctx.tenantId,
      ...(input.event !== undefined ? { event: input.event } : {}),
      ...(input.intent !== undefined ? { intent: input.intent } : {}),
      ...(input.context !== undefined ? { context: input.context } : {}),
    });
    if (resolution.status === "missing_action") {
      return this.terminalRun(ctx, {
        agentId,
        category,
        executionMode,
        status: "missing_action",
        reason: { ...reason, action_reason: resolution.reason },
        routingDecisionId: routing.id,
        input,
        confidence: decision.confidence,
        failureReason: resolution.reason,
        shadowMode: false,
      });
    }

    const bundle = await this.deps.evidence.gather({
      tenantId: ctx.tenantId,
      ...(input.context !== undefined ? { context: input.context } : {}),
      requiredEvidence: definition.required_evidence,
    });
    const reasonWithAction = {
      ...reason,
      action: resolution.action,
      action_source: resolution.source,
      missing_evidence: bundle.missing_required_evidence,
      capability_scopes_present: definition.capabilities,
      // No live gate runs on the shadow path; populated once money-movers are
      // promoted and the run path calls gate.evaluate({ dryRun: true }).
      policy_dryrun_outcome: null,
    };
    if (executionMode === "reject" || executionMode === "notify_only") {
      return this.terminalRun(ctx, {
        agentId,
        category,
        executionMode,
        status: executionMode === "reject" ? "rejected" : "notify_only",
        reason: reasonWithAction,
        routingDecisionId: routing.id,
        input,
        confidence: decision.confidence,
        evidenceScore: bundle.evidence_score,
        action: resolution.action,
        failureReason: `execution_mode_${executionMode}`,
        shadowMode: false,
      });
    }

    const proposed = handler.build({
      action: resolution.action,
      context: input.context ?? {},
      evidence: bundle,
    });
    const shadowed = this.deps.isShadowed(agentId);

    // SHADOW MODE: a financial proposal moves no money when the agent is
    // shadowed, OR (graduated rollout, 1b) when it's live but the action's rail
    // is not on the agent's allowlist.
    if (proposed.channel === "payment_intent") {
      const railBlocked =
        !shadowed &&
        this.deps.checkRail !== undefined &&
        !this.deps.checkRail(agentId, proposed.intent.action_type);
      if (shadowed || railBlocked) {
        const shadowReason = {
          ...reasonWithAction,
          shadow: shadowed ? "agent_shadowed" : "rail_not_allowlisted",
        };
        const run = await this.deps.store.recordRun(ctx, {
          tenantCategory: category,
          agentId,
          agentKind: definition.provenance,
          executionMode,
          status: "shadow_completed",
          reason: shadowReason,
          shadowMode: true,
          routingDecisionId: routing.id,
          eventType: input.event ?? null,
          intent: input.intent ?? null,
          action: resolution.action,
          confidence: decision.confidence,
          evidenceScore: bundle.evidence_score,
        });
        return {
          status: "shadow_completed",
          routing_decision_id: routing.id,
          run_id: run.id,
          selected_agent_id: agentId,
          action: resolution.action,
          shadow_mode: true,
          reason: shadowReason,
        };
      }
    }

    // Non-financial proposal (or — Phase 1b — a live financial one): propose
    // through the existing path. Reconciliation may delegate to its override.
    const override = this.deps.agentOverrides?.[agentId];
    const proposeDeps: ProposeDeps =
      override !== undefined
        ? { agents: override, paymentIntents: this.deps.propose.paymentIntents }
        : this.deps.propose;
    const result = await proposeAction(proposed, ctx, agentId, proposeDeps);

    const run = await this.deps.store.recordRun(ctx, {
      tenantCategory: category,
      agentId,
      agentKind: definition.provenance,
      executionMode,
      status: "proposal_created",
      reason: reasonWithAction,
      shadowMode: shadowed,
      routingDecisionId: routing.id,
      eventType: input.event ?? null,
      intent: input.intent ?? null,
      action: resolution.action,
      confidence: decision.confidence,
      evidenceScore: bundle.evidence_score,
      proposalId: proposed.channel === "agent" ? result.id : null,
      paymentIntentId: proposed.channel === "payment_intent" ? result.id : null,
      policyStatus: toPolicyStatus(result.policy_decision_id),
    });
    return {
      status: "proposal_created",
      routing_decision_id: routing.id,
      run_id: run.id,
      selected_agent_id: agentId,
      action: resolution.action,
      shadow_mode: shadowed,
      proposed: result,
      reason: reasonWithAction,
    };
  }

  private async terminalRun(
    ctx: ServiceCallContext,
    args: {
      agentId: string;
      category: "business" | "consumer";
      executionMode: ExecutionMode;
      status: AgentRunStatus;
      reason: Record<string, unknown>;
      routingDecisionId: string;
      input: RoutingInput;
      confidence: number;
      evidenceScore?: number | null;
      action?: string | null;
      failureReason: string;
      shadowMode: boolean;
    },
  ): Promise<AgentRunResult> {
    const kind = this.deps.definitions[args.agentId]?.provenance ?? "internal";
    const run = await this.deps.store.recordRun(ctx, {
      tenantCategory: args.category,
      agentId: args.agentId,
      agentKind: kind,
      executionMode: args.executionMode,
      status: args.status,
      reason: args.reason,
      shadowMode: args.shadowMode,
      routingDecisionId: args.routingDecisionId,
      eventType: args.input.event ?? null,
      intent: args.input.intent ?? null,
      action: args.action ?? null,
      confidence: args.confidence,
      evidenceScore: args.evidenceScore ?? null,
      failureReason: args.failureReason,
    });
    return {
      status: args.status,
      routing_decision_id: args.routingDecisionId,
      run_id: run.id,
      selected_agent_id: args.agentId,
      action: args.action ?? null,
      shadow_mode: args.shadowMode,
      reason: args.reason,
    };
  }
}

function toPolicyStatus(policyDecisionId: string | null): AgentPolicyStatus {
  return policyDecisionId === null ? "unknown" : "allow";
}
