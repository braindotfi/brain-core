import type { BrainHttpClient } from "../client.js";
import { BrainAPIError, type BrainErrorBody } from "../errors.js";
import type { Proof } from "./proof.js";

/** H-25 agent-run views (mirror shared/src/contracts/agent-run.ts). */
export interface AgentRunSummary {
  run_id: string;
  tenant_id: string;
  agent_id: string;
  agent_key: string;
  status: "completed" | "failed" | "shadow_completed" | "rejected";
  trigger: { kind: string; source_event_id?: string };
  resolved_action: { type: string; source: "explicit" | "event_map" };
  evidence_count: number;
  confidence: number;
  evidence_score: number;
  risk_level: "low" | "medium" | "high" | "critical";
  outcome: { kind: string; payment_intent_id?: string; reason?: string };
  started_at: string;
  completed_at: string;
}

export interface AgentRunWhy {
  run_id: string;
  selected_agent_id: string | null;
  candidate_agent_ids: string[];
  reason: Record<string, unknown>;
  behavior_hash: string | null;
}

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

function unwrap<T>(data: T | undefined, error: BrainErrorBody | undefined, status: number): T {
  if (error !== undefined || data === undefined) {
    throw new BrainAPIError(status, error);
  }
  return data;
}

/**
 * Agent Run History (H-25). Flagship trust artifact alongside the Proof API:
 * `brain.agentRuns.get/why/evidence/gateTrace/proof`.
 */
export class AgentRunsResource {
  constructor(private readonly http: BrainHttpClient) {}

  async get(runId: string): Promise<AgentRunSummary> {
    const { data, error, response } = await this.http.GET("/agents/runs/{run_id}", {
      params: { path: { run_id: runId } },
    });
    return unwrap(data, error, response.status) as unknown as AgentRunSummary;
  }

  async why(runId: string): Promise<AgentRunWhy> {
    const { data, error, response } = await this.http.GET("/agents/runs/{run_id}/why", {
      params: { path: { run_id: runId } },
    });
    return unwrap(data, error, response.status) as unknown as AgentRunWhy;
  }

  async evidence(runId: string): Promise<{ run_id: string; evidence: AgentRunEvidenceItem[] }> {
    const { data, error, response } = await this.http.GET("/agents/runs/{run_id}/evidence", {
      params: { path: { run_id: runId } },
    });
    return unwrap(data, error, response.status) as unknown as {
      run_id: string;
      evidence: AgentRunEvidenceItem[];
    };
  }

  async gateTrace(runId: string): Promise<AgentRunGateTrace> {
    const { data, error, response } = await this.http.GET("/agents/runs/{run_id}/gate-trace", {
      params: { path: { run_id: runId } },
    });
    return unwrap(data, error, response.status) as unknown as AgentRunGateTrace;
  }

  async proof(runId: string): Promise<Proof> {
    const { data, error, response } = await this.http.GET("/agents/runs/{run_id}/proof", {
      params: { path: { run_id: runId } },
    });
    return unwrap(data, error, response.status) as unknown as Proof;
  }
}
