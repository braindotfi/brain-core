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
  /** Optional targeted route for bounded fan-out callers. */
  readonly target_agent_id?: string;
  /** Event-layer dedupe key; duplicate keys skip handler execution. */
  readonly idempotency_key?: string;
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

export interface RoutingDecision {
  readonly selected_agent_id: string | null;
  readonly fallback_agent_ids: readonly string[];
  readonly confidence: number;
  readonly evidence_score: number;
  readonly policy_status: RoutingPolicyStatus;
  readonly execution_mode: ExecutionMode | null;
  readonly reason: string;
}

/**
 * Per-candidate reputation + cost signals.
 *
 * `reputation` is a normalized 0..1 blend of operational data
 * (success rate, policy rejection rate, dispute rate, agent state,
 * on-chain reputation pointer). `components` exposes the individual
 * inputs so a routing-decision audit event can explain why an agent
 * was preferred or downgraded.
 *
 * Architectural note: the router uses reputation as a TIGHTEN-ONLY
 * signal. The score is `0.6 * matchQuality + 0.25 * completeness +
 * 0.15 * reputation`, so a perfect reputation contributes at most
 * 0.15 and cannot override low evidence completeness. This mirrors
 * the Policy DSL rule (reputation can only tighten an outcome).
 */
export interface CandidateSignals {
  /** Normalized reputation, 0..1 (higher is better). */
  readonly reputation: number;
  /** Normalized cost, 0..1 (lower is better). */
  readonly cost: number;
  /** Per-component breakdown; omitted by trivial providers. */
  readonly components?: SignalsComponents;
}

/**
 * The five reputation inputs the PostgresSignalsProvider mixes.
 * All values are 0..1. `successRate` and `onchainReputation` are
 * higher-is-better; the others are higher-is-worse and are inverted
 * before mixing.
 */
export interface SignalsComponents {
  /** Completed PaymentIntents / total proposed for this agent. */
  readonly successRate: number;
  /** Policy decisions with outcome=reject for this agent. */
  readonly policyRejectionRate: number;
  /** Disputed releases when escrow is live (placeholder today). */
  readonly disputeRate: number;
  /** 0 when agent is active; 1 when revoked/quarantined/failed. */
  readonly agentStatePenalty: number;
  /** On-chain BrainReputationRegistry pointer (0.5 when no pointer). */
  readonly onchainReputation: number;
  /** Total number of PaymentIntents the rates were computed over. */
  readonly sampleSize: number;
}
