/**
 * H-25 pure projections: agent_runs / agent_routing_decisions rows → the
 * customer-facing AgentRunSummary / AgentRunWhy shapes. Pure + best-effort over
 * loose row objects (the read store returns `unknown`), so they are unit-tested
 * without a DB. Fields not persisted as first-class columns (agent_key,
 * risk_level, trigger source, evidence_count) are read from the run's structured
 * `reason` JSONB or fall back to documented defaults.
 */

import type {
  AgentRunRiskLevel,
  AgentRunSummary,
  AgentRunSummaryStatus,
  AgentRunWhy,
} from "@brain/shared";

type Loose = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function iso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") return v;
  return new Date(0).toISOString();
}

/** Map the wide agent_runs.status vocabulary onto the 4 summary outcomes. */
export function toSummaryStatus(runStatus: string): AgentRunSummaryStatus {
  switch (runStatus) {
    case "rejected":
      return "rejected";
    case "shadow_completed":
      return "shadow_completed";
    case "failed":
    case "missing_handler":
    case "missing_action":
    case "missing_evidence":
    case "no_match":
    case "unscoped":
      return "failed";
    default:
      // executed | proposal_created | notify_only | confirmation_required |
      // paused | duplicate_skipped | routing | routed → ran to a normal end.
      return "completed";
  }
}

const RISK_LEVELS: ReadonlySet<string> = new Set(["low", "medium", "high", "critical"]);

export function toAgentRunSummary(
  run: Loose,
  opts: { evidenceCount?: number } = {},
): AgentRunSummary {
  const reason = (run.reason ?? {}) as Loose;
  const status = String(run.status ?? "");
  const intent = str(run.intent);
  const riskRaw = str(reason.risk_level);
  const risk: AgentRunRiskLevel =
    riskRaw !== undefined && RISK_LEVELS.has(riskRaw) ? (riskRaw as AgentRunRiskLevel) : "low";

  const trigger: AgentRunSummary["trigger"] = {
    kind: str(run.event_type) ?? intent ?? "manual",
  };
  const sourceEventId = str(reason.source_event_id) ?? str(run.object_id);
  if (str(run.event_type) !== undefined && sourceEventId !== undefined) {
    trigger.source_event_id = sourceEventId;
  }

  const outcome: AgentRunSummary["outcome"] = { kind: status };
  const pi = str(run.payment_intent_id);
  if (pi !== undefined) outcome.payment_intent_id = pi;
  const failure = str(run.failure_reason);
  if (failure !== undefined) outcome.reason = failure;

  return {
    run_id: String(run.id ?? ""),
    tenant_id: String(run.tenant_id ?? ""),
    agent_id: String(run.agent_id ?? ""),
    agent_key: str(run.agent_key) ?? str(reason.agent_key) ?? String(run.agent_id ?? ""),
    status: toSummaryStatus(status),
    trigger,
    resolved_action: {
      type: str(run.action) ?? "unknown",
      // An explicit intent → explicit; routed from an event → event_map.
      source: intent !== undefined ? "explicit" : "event_map",
    },
    evidence_count: opts.evidenceCount ?? num(reason.evidence_count) ?? 0,
    confidence: num(run.confidence) ?? 0,
    evidence_score: num(run.evidence_score) ?? 0,
    risk_level: risk,
    outcome,
    started_at: iso(run.created_at),
    completed_at: iso(run.completed_at ?? run.created_at),
  };
}

/** Join the run's routing decision into the "why this agent" view. */
export function toAgentRunWhy(
  run: Loose,
  routingDecision: Loose | null,
  behaviorHash: string | null,
): AgentRunWhy {
  const rd = routingDecision ?? {};
  const fallback = Array.isArray(rd.fallback_agent_ids) ? (rd.fallback_agent_ids as string[]) : [];
  const selected = str(rd.selected_agent_id) ?? str(run.agent_id) ?? null;
  const candidates = [...(selected !== null ? [selected] : []), ...fallback];
  return {
    run_id: String(run.id ?? ""),
    selected_agent_id: selected,
    candidate_agent_ids: candidates,
    reason: (rd.reason ?? run.reason ?? {}) as Record<string, unknown>,
    behavior_hash: behaviorHash,
  };
}
