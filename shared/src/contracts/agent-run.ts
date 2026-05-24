/**
 * H-25 Agent Run History — the customer-facing view of what an agent
 * considered and decided, step by step. Complements the Proof API (H-07): proof
 * says "this action is verifiable"; run history says "here is the reasoning".
 *
 * Read-only projections over agent_runs / agent_routing_decisions /
 * agent_evidence_refs (Layer 5). Tenant-isolated by RLS.
 */

export type AgentRunSummaryStatus = "completed" | "failed" | "shadow_completed" | "rejected";

export type AgentRunRiskLevel = "low" | "medium" | "high" | "critical";

export interface AgentRunSummary {
  run_id: string;
  tenant_id: string;
  agent_id: string;
  agent_key: string;
  status: AgentRunSummaryStatus;
  trigger: { kind: string; source_event_id?: string };
  resolved_action: { type: string; source: "explicit" | "event_map" };
  evidence_count: number;
  confidence: number;
  evidence_score: number;
  risk_level: AgentRunRiskLevel;
  outcome: { kind: string; payment_intent_id?: string; reason?: string };
  started_at: string;
  completed_at: string;
}

/** /why — why this agent was selected (router multi-factor + behavior hash). */
export interface AgentRunWhy {
  run_id: string;
  selected_agent_id: string | null;
  candidate_agent_ids: string[];
  /** Router multi-factor reason: score, evidence completeness, reputation, cost. */
  reason: Record<string, unknown>;
  behavior_hash: string | null;
}

/** /evidence — the evidence chain the agent consumed for the run. */
export interface AgentRunEvidenceItem {
  id: string;
  kind: string;
  ref: string;
  source_system: string | null;
  object_type: string | null;
  object_id: string | null;
  confidence: number | null;
  hash: string | null;
  stale: boolean;
  required: boolean | null;
}

/** /gate-trace — the §6 gate check trace if a gate ran during this run. */
export interface AgentRunGateTrace {
  run_id: string;
  payment_intent_id: string | null;
  gate_checks: Array<{
    index: number;
    name: string;
    passed: boolean;
    detail?: Record<string, unknown>;
  }>;
}
