/**
 * proposals / executions / agents repositories. All tenant-scoped.
 */

import type { TenantScopedClient } from "@brain/api/shared";
import type { Decision } from "@brain/policy";
import {
  assertAgentTransition,
  assertExecutionTransition,
  assertProposalTransition,
  type AgentState,
  type ExecutionState,
  type ProposalState,
} from "./state-machines.js";

// ---------- proposals ----------

export interface ProposalRow {
  id: string;
  tenant_id: string;
  proposing_agent: string;
  action: Record<string, unknown>;
  policy_version: number;
  policy_decision: "allow" | "confirm" | "reject";
  policy_trace: Decision["trace"];
  required_approvers: string[];
  status: ProposalState;
  approvers_signed: string[];
  created_at: Date;
}

export interface InsertProposalInput {
  id: string;
  tenantId: string;
  proposingAgent: string;
  action: Record<string, unknown>;
  policyVersion: number;
  policyDecision: ProposalRow["policy_decision"];
  policyTrace: Decision["trace"];
  requiredApprovers: string[];
  status: ProposalState;
}

export async function insertProposal(
  client: TenantScopedClient,
  input: InsertProposalInput,
): Promise<ProposalRow> {
  const { rows } = await client.query<ProposalRow>(
    `INSERT INTO proposals (id, tenant_id, proposing_agent, action, policy_version,
                           policy_decision, policy_trace, required_approvers, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [
      input.id,
      input.tenantId,
      input.proposingAgent,
      JSON.stringify(input.action),
      input.policyVersion,
      input.policyDecision,
      JSON.stringify(input.policyTrace),
      input.requiredApprovers,
      input.status,
    ],
  );
  const row = rows[0];
  if (row === undefined) throw new Error("proposals insert returned no row");
  return row;
}

export async function findProposal(
  client: TenantScopedClient,
  id: string,
): Promise<ProposalRow | null> {
  const { rows } = await client.query<ProposalRow>(
    `SELECT * FROM proposals WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function transitionProposal(
  client: TenantScopedClient,
  id: string,
  from: ProposalState,
  to: ProposalState,
): Promise<ProposalRow> {
  assertProposalTransition(from, to);
  const { rows } = await client.query<ProposalRow>(
    `UPDATE proposals SET status = $1 WHERE id = $2 AND status = $3 RETURNING *`,
    [to, id, from],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`proposal ${id} not in state ${from}`);
  }
  return row;
}

export async function appendApproverSigned(
  client: TenantScopedClient,
  id: string,
  approverId: string,
): Promise<ProposalRow | null> {
  const { rows } = await client.query<ProposalRow>(
    `UPDATE proposals
        SET approvers_signed = array_append(approvers_signed, $1)
      WHERE id = $2 AND NOT ($1 = ANY (approvers_signed))
      RETURNING *`,
    [approverId, id],
  );
  return rows[0] ?? null;
}

// ---------- executions ----------

export interface ExecutionRow {
  id: string;
  tenant_id: string;
  proposal_id: string;
  rail: string;
  rail_receipt: Record<string, unknown> | null;
  status: ExecutionState;
  idempotency_key: string | null;
  started_at: Date;
  completed_at: Date | null;
}

export async function insertExecution(
  client: TenantScopedClient,
  input: {
    id: string;
    tenantId: string;
    proposalId: string;
    rail: string;
    status: ExecutionState;
    idempotencyKey?: string;
  },
): Promise<ExecutionRow> {
  const { rows } = await client.query<ExecutionRow>(
    `INSERT INTO executions (id, tenant_id, proposal_id, rail, status, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [
      input.id,
      input.tenantId,
      input.proposalId,
      input.rail,
      input.status,
      input.idempotencyKey ?? null,
    ],
  );
  const row = rows[0];
  if (row === undefined) throw new Error("executions insert returned no row");
  return row;
}

export async function findExecution(
  client: TenantScopedClient,
  id: string,
): Promise<ExecutionRow | null> {
  const { rows } = await client.query<ExecutionRow>(
    `SELECT * FROM executions WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function setExecutionReceipt(
  client: TenantScopedClient,
  id: string,
  receipt: Record<string, unknown>,
): Promise<void> {
  await client.query(`UPDATE executions SET rail_receipt = $1 WHERE id = $2`, [
    JSON.stringify(receipt),
    id,
  ]);
}

export async function transitionExecution(
  client: TenantScopedClient,
  id: string,
  from: ExecutionState,
  to: ExecutionState,
): Promise<ExecutionRow> {
  assertExecutionTransition(from, to);
  const completedClause = to === "completed" || to === "failed" ? ", completed_at = now()" : "";
  const { rows } = await client.query<ExecutionRow>(
    `UPDATE executions SET status = $1${completedClause}
       WHERE id = $2 AND status = $3 RETURNING *`,
    [to, id, from],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`execution ${id} not in state ${from}`);
  return row;
}

// ---------- agents ----------

export interface AgentRow {
  id: string;
  tenant_id: string;
  kind: "internal" | "external";
  role: string;
  display_name: string;
  scope_hash: Buffer | null;
  onchain_address: string | null;
  state: AgentState;
  registered_tx: string | null;
  registered_at: Date | null;
  created_at: Date;
}

export async function insertAgent(
  client: TenantScopedClient,
  input: Omit<AgentRow, "created_at" | "registered_at"> & { registeredAt?: Date },
): Promise<AgentRow> {
  const { rows } = await client.query<AgentRow>(
    `INSERT INTO agents (id, tenant_id, kind, role, display_name, scope_hash,
                         onchain_address, state, registered_tx, registered_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [
      input.id,
      input.tenant_id,
      input.kind,
      input.role,
      input.display_name,
      input.scope_hash,
      input.onchain_address,
      input.state,
      input.registered_tx,
      input.registeredAt ?? null,
    ],
  );
  const row = rows[0];
  if (row === undefined) throw new Error("agents insert returned no row");
  return row;
}

export async function findAgent(client: TenantScopedClient, id: string): Promise<AgentRow | null> {
  const { rows } = await client.query<AgentRow>(`SELECT * FROM agents WHERE id = $1 LIMIT 1`, [id]);
  return rows[0] ?? null;
}

export async function listAgents(client: TenantScopedClient): Promise<AgentRow[]> {
  const { rows } = await client.query<AgentRow>(`SELECT * FROM agents ORDER BY created_at DESC`);
  return rows;
}

export async function transitionAgent(
  client: TenantScopedClient,
  id: string,
  from: AgentState,
  to: AgentState,
): Promise<AgentRow> {
  assertAgentTransition(from, to);
  const { rows } = await client.query<AgentRow>(
    `UPDATE agents SET state = $1${to === "active" ? ", registered_at = now()" : ""}
       WHERE id = $2 AND state = $3 RETURNING *`,
    [to, id, from],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`agent ${id} not in state ${from}`);
  return row;
}
