/**
 * agent_proposals repository (BRAIN-CORE-ORCHESTRATION-GAP.md §3). Tenant-scoped.
 */

import type { TenantScopedClient } from "@brain/shared";
import { brainError, newAgentProposalId } from "@brain/shared";
import type {
  AgentProposalDecision,
  AgentProposalExecutionMode,
  AgentProposalStatus,
} from "./state-machine.js";

export type AgentProposalType =
  | "vendor_risk"
  | "payment_batch"
  | "collections"
  | "treasury"
  | "cash_forecast"
  | "dispute"
  | "compliance"
  | "revenue_intel"
  | "reconciliation"
  | "subscription"
  | "fraud_anomaly";

export type AgentProposalRiskBand = "low" | "standard" | "elevated" | "high";

export interface AgentProposalEvidenceItem {
  text: string;
  wiki_entity_id?: string;
}

export interface AgentProposalLinks {
  payment_intent_id?: string | null;
  counterparty_id?: string | null;
  raw_id?: string | null;
}

export interface AgentProposalRow {
  id: string;
  tenant_id: string;
  type: AgentProposalType;
  agent_principal: string;
  risk_band: AgentProposalRiskBand;
  execution_mode: AgentProposalExecutionMode;
  status: AgentProposalStatus;
  title: string;
  amount: string | null;
  confidence: string | null;
  narrative: string;
  evidence: AgentProposalEvidenceItem[];
  links: AgentProposalLinks;
  policy_decision_id: string | null;
  reversible: boolean;
  decision: AgentProposalDecision | null;
  decision_edit: Record<string, unknown> | null;
  decided_by: string | null;
  decided_at: Date | null;
  created_at: Date;
}

export interface InsertAgentProposalInput {
  id?: string;
  tenantId: string;
  type: AgentProposalType;
  agentPrincipal: string;
  riskBand: AgentProposalRiskBand;
  executionMode: AgentProposalExecutionMode;
  status?: AgentProposalStatus;
  title: string;
  amount?: string | null;
  confidence?: number | null;
  narrative?: string;
  evidence?: AgentProposalEvidenceItem[];
  links?: AgentProposalLinks;
  policyDecisionId?: string | null;
  reversible?: boolean;
  decision?: AgentProposalDecision | null;
  decidedBy?: string | null;
  decidedAt?: Date | null;
  createdAt?: Date;
}

export async function insertAgentProposal(
  client: TenantScopedClient,
  input: InsertAgentProposalInput,
): Promise<AgentProposalRow> {
  const { rows } = await client.query<AgentProposalRow>(
    `INSERT INTO agent_proposals (
       id, tenant_id, type, agent_principal, risk_band, execution_mode, status,
       title, amount, confidence, narrative, evidence, links, policy_decision_id,
       reversible, decision, decided_by, decided_at, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15,$16,$17,$18,
               COALESCE($19, now()))
     RETURNING *`,
    [
      input.id ?? newAgentProposalId(),
      input.tenantId,
      input.type,
      input.agentPrincipal,
      input.riskBand,
      input.executionMode,
      input.status ?? "needs_review",
      input.title,
      input.amount ?? null,
      input.confidence ?? null,
      input.narrative ?? "",
      JSON.stringify(input.evidence ?? []),
      JSON.stringify(input.links ?? {}),
      input.policyDecisionId ?? null,
      input.reversible ?? false,
      input.decision ?? null,
      input.decidedBy ?? null,
      input.decidedAt ?? null,
      input.createdAt ?? null,
    ],
  );
  const row = rows[0];
  if (row === undefined) throw new Error("agent_proposals insert returned no row");
  return row;
}

export interface ListAgentProposalsFilters {
  status?: AgentProposalStatus;
  type?: AgentProposalType;
  limit?: number;
}

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;

export async function listAgentProposals(
  client: TenantScopedClient,
  filters: ListAgentProposalsFilters = {},
): Promise<AgentProposalRow[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (filters.status !== undefined) {
    values.push(filters.status);
    conditions.push(`status = $${values.length}`);
  }
  if (filters.type !== undefined) {
    values.push(filters.type);
    conditions.push(`type = $${values.length}`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(Math.max(filters.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
  values.push(limit);
  const { rows } = await client.query<AgentProposalRow>(
    `SELECT * FROM agent_proposals ${where} ORDER BY created_at DESC LIMIT $${values.length}`,
    values,
  );
  return rows;
}

export async function getAgentProposal(
  client: TenantScopedClient,
  id: string,
): Promise<AgentProposalRow | null> {
  const { rows } = await client.query<AgentProposalRow>(
    `SELECT * FROM agent_proposals WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

export interface DecideAgentProposalInput {
  id: string;
  expectedStatus: AgentProposalStatus;
  status: AgentProposalStatus;
  decision: AgentProposalDecision;
  decidedBy: string;
  edit?: { amount?: string } & Record<string, unknown>;
}

/**
 * Compare-and-swap the decision onto a proposal. 0 rows affected (the row
 * moved between load and decide) throws `agent_proposal_invalid_state` so a
 * lost CAS race and an illegal transition surface the same way to the caller.
 */
export async function decideAgentProposal(
  client: TenantScopedClient,
  input: DecideAgentProposalInput,
): Promise<AgentProposalRow> {
  const amountClause = input.edit?.amount !== undefined ? ", amount = $6" : "";
  const values: unknown[] = [
    input.status,
    input.decision,
    JSON.stringify(input.edit ?? null),
    input.decidedBy,
    input.id,
  ];
  if (input.edit?.amount !== undefined) values.push(input.edit.amount);
  values.push(input.expectedStatus);
  const { rows } = await client.query<AgentProposalRow>(
    `UPDATE agent_proposals
        SET status = $1, decision = $2, decision_edit = $3::jsonb, decided_by = $4,
            decided_at = now()${amountClause}
      WHERE id = $5 AND status = $${values.length}
      RETURNING *`,
    values,
  );
  const row = rows[0];
  if (row === undefined) {
    throw brainError(
      "agent_proposal_invalid_state",
      `agent proposal ${input.id} not in state ${input.expectedStatus}`,
    );
  }
  return row;
}

export interface AgentProposalSummary {
  id: string;
  type: AgentProposalType;
  agent_principal: string;
  risk_band: AgentProposalRiskBand;
  status: AgentProposalStatus;
  title: string;
  amount: string | null;
  created_at: string;
}

export function serializeAgentProposalSummary(row: AgentProposalRow): AgentProposalSummary {
  return {
    id: row.id,
    type: row.type,
    agent_principal: row.agent_principal,
    risk_band: row.risk_band,
    status: row.status,
    title: row.title,
    amount: row.amount,
    created_at: row.created_at.toISOString(),
  };
}

export interface AgentProposalView extends AgentProposalSummary {
  execution_mode: AgentProposalExecutionMode;
  narrative: string;
  evidence: AgentProposalEvidenceItem[];
  links: AgentProposalLinks;
  policy_decision_id: string | null;
  confidence: number | null;
  reversible: boolean;
  decision: AgentProposalDecision | null;
  decided_by: string | null;
  decided_at: string | null;
}

export function serializeAgentProposal(row: AgentProposalRow): AgentProposalView {
  return {
    ...serializeAgentProposalSummary(row),
    execution_mode: row.execution_mode,
    narrative: row.narrative,
    evidence: row.evidence,
    links: row.links,
    policy_decision_id: row.policy_decision_id,
    confidence: row.confidence === null ? null : Number(row.confidence),
    reversible: row.reversible,
    decision: row.decision,
    decided_by: row.decided_by,
    decided_at: row.decided_at === null ? null : row.decided_at.toISOString(),
  };
}
