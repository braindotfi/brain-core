/**
 * AgentRouter — selects an agent for an event or intent.
 *
 * Selection (matches protocol/agents.md):
 *   a. filter candidates by capability match (event trigger or intent pattern)
 *   b. filter by tenant scope grants (only agents the tenant has scoped)
 *   c. score: trigger_match, intent_match, evidence completeness, reputation, cost
 *   d. pick top score; return fallbacks; emit a selection audit event
 *
 * The router NEVER executes. The selected agent proposes through the existing
 * /v1/agents/{id}/propose path, which runs Policy and the §6 gate.
 */

import type { AuditEmitter, ServiceCallContext, TenantCategory } from "@brain/shared";
import { resolveExecutionMode } from "@brain/shared";
import type { InternalAgentDefinition } from "@brain/schemas";
import type { IntentClassifier } from "./intent-classifier.js";
import type { EvidenceGatherer } from "./evidence-gatherer.js";
import type { CandidateSignals, RoutingDecision, RoutingInput } from "./types.js";

const INTENT_MATCH_THRESHOLD = 0.5;
const COST_PENALTY = 0.1;
const HIGH_CONFIDENCE = 0.85;
/**
 * Penalty applied to a candidate whose category does not match the tenant's
 * (and is not `agnostic`). It is a downgrade, not a reject: it flips the
 * choice between two trigger-only matches of different categories, but a
 * strong explicit intent (which feeds `matchQuality`, weight 0.6) still
 * outweighs it, so user intent can override the default category preference.
 */
const CATEGORY_MISMATCH_PENALTY = 0.2;

const DEFAULT_SIGNALS: CandidateSignals = { reputation: 0.5, cost: 0 };

export interface AgentRouterDeps {
  /** The internal-agent catalog the router selects over. */
  readonly catalog: () =>
    | readonly InternalAgentDefinition[]
    | Promise<readonly InternalAgentDefinition[]>;
  readonly classifier: IntentClassifier;
  readonly evidence: EvidenceGatherer;
  /** Capabilities the tenant has scoped (on-chain ScopeAttestation grants). */
  readonly getScopedCapabilities: (
    tenantId: string,
  ) => ReadonlySet<string> | Promise<ReadonlySet<string>>;
  readonly audit: AuditEmitter;
  /** Per-candidate reputation + cost. Defaults to neutral signals. */
  readonly signals?: (agentKey: string) => CandidateSignals;
  /**
   * Resolve the tenant's category (business | consumer). When provided, a
   * candidate whose category mismatches is downgraded (not rejected), so a
   * trigger shared across categories prefers the matching agent. When absent
   * or undefined, routing is category-blind (Phase 1/2 behavior preserved).
   */
  readonly getTenantCategory?: (
    tenantId: string,
  ) => TenantCategory | undefined | Promise<TenantCategory | undefined>;
}

interface Scored {
  readonly def: InternalAgentDefinition;
  readonly confidence: number;
  readonly selectionScore: number;
  readonly completeness: number;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export class AgentRouter {
  constructor(private readonly deps: AgentRouterDeps) {}

  async route(ctx: ServiceCallContext, input: RoutingInput): Promise<RoutingDecision> {
    await this.deps.audit.emit({
      tenantId: ctx.tenantId,
      layer: "agent",
      actor: ctx.actor,
      action: "agent.router.started",
      inputs: { event: input.event ?? null, intent: input.intent ?? null },
      outputs: {},
    });

    const catalog = await this.deps.catalog();
    const enabled = catalog.filter((def) => def.enabled_by_default);
    const matchFlags = await Promise.all(enabled.map((def) => this.matches(def, input)));
    const candidates = enabled.filter((_, i) => matchFlags[i]);

    if (candidates.length === 0) {
      return this.noMatch(ctx, input, "no_match", "no agent matches the event or intent");
    }

    const scoped = await this.deps.getScopedCapabilities(input.tenant_id);
    const eligible = candidates.filter((def) => def.capabilities.some((c) => scoped.has(c)));

    if (eligible.length === 0) {
      return this.noMatch(
        ctx,
        input,
        "unscoped",
        "matching agents exist but the tenant has scoped none of them",
      );
    }

    const tenantCategory = (await this.deps.getTenantCategory?.(input.tenant_id)) ?? undefined;
    const scored = await Promise.all(eligible.map((def) => this.score(def, input, tenantCategory)));
    scored.sort((a, b) => b.selectionScore - a.selectionScore);

    const winner = scored[0]!;
    const fallbacks = scored.slice(1).map((s) => s.def.agent_key);
    const evidenceComplete = winner.completeness >= 1;
    const executionMode = resolveExecutionMode({
      decision: "ALLOW",
      confidence: winner.confidence,
      evidenceComplete,
      minimumConfidence: winner.def.minimum_confidence,
      riskLevel: winner.def.risk_level,
      highConfidenceThreshold: HIGH_CONFIDENCE,
    });

    const decision: RoutingDecision = {
      selected_agent_id: winner.def.agent_key,
      fallback_agent_ids: fallbacks,
      confidence: winner.confidence,
      evidence_score: winner.completeness,
      policy_status: "routed",
      execution_mode: executionMode,
      reason: `selected ${winner.def.agent_key} (confidence ${winner.confidence.toFixed(2)})`,
    };

    await this.deps.audit.emit({
      tenantId: ctx.tenantId,
      layer: "agent",
      actor: ctx.actor,
      action: "agent.router.selected",
      inputs: { event: input.event ?? null, intent: input.intent ?? null },
      outputs: {
        selected_agent_id: decision.selected_agent_id,
        fallback_agent_ids: decision.fallback_agent_ids,
        confidence: decision.confidence,
        evidence_score: decision.evidence_score,
        execution_mode: decision.execution_mode,
      },
    });

    return decision;
  }

  private async matches(def: InternalAgentDefinition, input: RoutingInput): Promise<boolean> {
    if (input.event !== undefined && def.triggers.includes(input.event)) {
      return true;
    }
    if (input.intent !== undefined) {
      const score = await this.deps.classifier.classify(input.intent, def.intent_patterns);
      return score >= INTENT_MATCH_THRESHOLD;
    }
    return false;
  }

  private async score(
    def: InternalAgentDefinition,
    input: RoutingInput,
    tenantCategory: TenantCategory | undefined,
  ): Promise<Scored> {
    const triggerMatch = input.event !== undefined && def.triggers.includes(input.event) ? 1 : 0;
    const intentScore =
      input.intent !== undefined
        ? await this.deps.classifier.classify(input.intent, def.intent_patterns)
        : 0;
    const bundle = await this.deps.evidence.gather({
      tenantId: input.tenant_id,
      ...(input.context !== undefined ? { context: input.context } : {}),
      requiredEvidence: def.required_evidence,
    });
    const { reputation, cost } = this.deps.signals?.(def.agent_key) ?? DEFAULT_SIGNALS;

    const matchQuality = Math.max(triggerMatch, intentScore);
    const confidence = clamp01(0.6 * matchQuality + 0.25 * bundle.completeness + 0.15 * reputation);
    // Category alignment: downgrade (never reject) a candidate whose category
    // mismatches the tenant. `agnostic` agents serve both, so no penalty.
    const categoryMismatch =
      tenantCategory !== undefined &&
      def.category !== "agnostic" &&
      def.category !== tenantCategory;
    const selectionScore =
      confidence - COST_PENALTY * cost - (categoryMismatch ? CATEGORY_MISMATCH_PENALTY : 0);
    return { def, confidence, selectionScore, completeness: bundle.completeness };
  }

  private async noMatch(
    ctx: ServiceCallContext,
    input: RoutingInput,
    policyStatus: "no_match" | "unscoped",
    reason: string,
  ): Promise<RoutingDecision> {
    await this.deps.audit.emit({
      tenantId: ctx.tenantId,
      layer: "agent",
      actor: ctx.actor,
      action: "agent.router.no_match",
      inputs: { event: input.event ?? null, intent: input.intent ?? null },
      outputs: { policy_status: policyStatus },
    });
    return {
      selected_agent_id: null,
      fallback_agent_ids: [],
      confidence: 0,
      evidence_score: 0,
      policy_status: policyStatus,
      execution_mode: null,
      reason,
    };
  }
}
