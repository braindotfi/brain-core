/**
 * Agent-router wire + internal types.
 *
 * The router selects an agent for an event or intent and returns a routing
 * decision. It NEVER executes — the selected agent proposes through the
 * existing /v1/agents/{id}/propose path, which runs Policy and the §6 gate.
 */

import type { ExecutionMode } from "@brain/shared";

export interface RoutingInput {
  readonly tenant_id: string;
  /** Domain-event name, e.g. "invoice.overdue". */
  readonly event?: string;
  /** Free-form natural-language intent, classified against intent_patterns. */
  readonly intent?: string;
  readonly context?: Record<string, unknown>;
}

/**
 * Whether routing produced a policy-eligible candidate:
 *   - "routed"   — a scoped, capable agent was selected
 *   - "unscoped" — capable candidates exist but the tenant has not scoped any
 *   - "no_match" — no agent matches the event/intent
 */
export type RoutingPolicyStatus = "routed" | "unscoped" | "no_match";

export interface Evidence {
  readonly kind: string;
  readonly ref: string;
  readonly excerpt?: string;
}

export interface EvidenceBundle {
  readonly items: readonly Evidence[];
  /** Fraction of required evidence kinds present (0..1). */
  readonly completeness: number;
}

export interface RoutingDecision {
  readonly selected_agent_id: string | null;
  readonly fallback_agent_ids: readonly string[];
  readonly confidence: number;
  readonly evidence_score: number;
  readonly policy_status: RoutingPolicyStatus;
  readonly execution_mode: ExecutionMode | null;
  readonly reason: string;
}

/** Per-candidate reputation + cost signals. Phase 1 uses neutral defaults;
 *  ERC-8004 reputation + a real cost model wire in later. */
export interface CandidateSignals {
  /** Normalized reputation, 0..1 (higher is better). */
  readonly reputation: number;
  /** Normalized cost, 0..1 (lower is better). */
  readonly cost: number;
}
