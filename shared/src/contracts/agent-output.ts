/**
 * H-16 canonical agent output.
 *
 * Every agent recommendation carries the machine-checkable signals Policy needs
 * to gate on: confidence, evidence completeness, and risk level. The new policy
 * VM primitives `agent.confidence.gte`, `agent.evidence_score.gte`, and
 * `agent.risk_level.lte` (services/policy) read exactly these fields, and the
 * execution-mode resolver consumes this shape via `resolveExecutionModeFromOutput`.
 *
 * Scope note (H-16): the contract + the VM primitives + the resolver adapter are
 * the policy-gating surface. The AgentOutput for a run is assembled centrally
 * from the agent definition's risk level + the router/evidence pipeline's
 * computed confidence/evidence — handler `build()` signatures are left intact so
 * the proposal pipeline is not destabilized. Migrating each handler to emit the
 * shape directly is a mechanical follow-up.
 */

export type AgentRiskLevel = "low" | "medium" | "high" | "critical";

export type AgentSuggestedExecutionMode = "notify_only" | "propose" | "confirm" | "execute";

export interface AgentMissingEvidence {
  kind: string;
  reason: string;
}

export interface AgentOutput<TRecommendation = unknown> {
  recommendation: TRecommendation;
  /** 0.0..1.0 — model/heuristic confidence in the recommendation. */
  confidence: number;
  /** 0.0..1.0 — completeness/strength of the evidence supporting it. */
  evidence_score: number;
  missing_evidence: AgentMissingEvidence[];
  risk_level: AgentRiskLevel;
  /** e.g. ["propose_payment", "notify_human"]. */
  allowed_next_actions: string[];
  suggested_execution_mode: AgentSuggestedExecutionMode;
}

/** Total order over risk levels (low < medium < high < critical). */
export const AGENT_RISK_ORDER: ReadonlyArray<AgentRiskLevel> = [
  "low",
  "medium",
  "high",
  "critical",
];

export function agentRiskRank(level: AgentRiskLevel): number {
  return AGENT_RISK_ORDER.indexOf(level);
}
