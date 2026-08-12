/**
 * proposals / executions / agents / users repositories. All tenant-scoped.
 */

import type { TenantScopedClient } from "@brain/shared";
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
  proposal_dedup_key: string | null;
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
  /** Proposal-layer idempotency key (1a.5); null means no dedup is enforced. */
  proposalDedupKey?: string | null;
}

export async function insertProposal(
  client: TenantScopedClient,
  input: InsertProposalInput,
): Promise<ProposalRow> {
  const { rows } = await client.query<ProposalRow>(
    `INSERT INTO proposals (id, tenant_id, proposing_agent, action, policy_version,
                           policy_decision, policy_trace, required_approvers, status,
                           proposal_dedup_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
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
      input.proposalDedupKey ?? null,
    ],
  );
  const row = rows[0];
  if (row === undefined) throw new Error("proposals insert returned no row");
  return row;
}

/** Look up an existing proposal by its proposal-layer dedup key (1a.5). */
export async function findProposalByDedupKey(
  client: TenantScopedClient,
  dedupKey: string,
): Promise<ProposalRow | null> {
  const { rows } = await client.query<ProposalRow>(
    `SELECT * FROM proposals WHERE proposal_dedup_key = $1 LIMIT 1`,
    [dedupKey],
  );
  return rows[0] ?? null;
}

const COLLECTIONS_PROPOSAL_LOCK_NAMESPACE = 0x434f4c4c; // "COLL"

/**
 * Serialize Collections proposal refreshes for one invoice. The partial index
 * added for this query makes the normal lookup cheap; the advisory lock closes
 * the read-then-insert race without imposing a uniqueness constraint on legacy
 * rows that the guarded production cleanup still needs to repair.
 */
export async function lockCollectionsProposalForInvoice(
  client: TenantScopedClient,
  tenantId: string,
  invoiceId: string,
): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(${COLLECTIONS_PROPOSAL_LOCK_NAMESPACE}, hashtext($1))`,
    [`${tenantId}:collections:${invoiceId}`],
  );
}

/** Find the single actionable Collections proposal for an invoice, if one exists. */
export async function findPendingCollectionsProposalForInvoice(
  client: TenantScopedClient,
  invoiceId: string,
): Promise<ProposalRow | null> {
  const { rows } = await client.query<ProposalRow>(
    `SELECT *
      FROM proposals
      WHERE proposing_agent = 'collections'
        AND status = 'pending'
        AND action->>'type' = 'collections'
        AND action->>'invoice_id' = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 1
      FOR UPDATE`,
    [invoiceId],
  );
  return rows[0] ?? null;
}

/** Refresh a pending Collections proposal in place after a later overdue sweep. */
export async function refreshCollectionsProposal(
  client: TenantScopedClient,
  existing: ProposalRow,
  input: Omit<InsertProposalInput, "id" | "tenantId" | "proposingAgent">,
): Promise<ProposalRow> {
  if (existing.status !== input.status) {
    assertProposalTransition(existing.status, input.status);
  }
  const { rows } = await client.query<ProposalRow>(
    `UPDATE proposals
        SET action = $2,
            policy_version = $3,
            policy_decision = $4,
            policy_trace = $5,
            required_approvers = $6,
            status = $7,
            updated_at = now()
      WHERE id = $1
        AND status = 'pending'
      RETURNING *`,
    [
      existing.id,
      JSON.stringify(input.action),
      input.policyVersion,
      input.policyDecision,
      JSON.stringify(input.policyTrace),
      input.requiredApprovers,
      input.status,
    ],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`collections proposal ${existing.id} stopped being pending during refresh`);
  }
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
  /* "none" | "tenant_signed" | "onchain_custodial" (services/execution/migrations
   * /0031_agents_attestation_mode.sql). RFC 0002 Phase C: "none" is the tier-1
   * unattested path (services/mcp/src/auth.ts MCP_UNATTESTED_SCOPES). */
  attestation_mode: string;
  /* Retry durability for the on-chain registration relayer worker
   * (services/execution/migrations/0032_agents_attestation_attempts.sql). */
  onchain_attestation_attempts: number;
  last_attestation_error: string | null;
  next_attempt_at: Date | null;
}

export async function insertAgent(
  client: TenantScopedClient,
  input: Omit<
    AgentRow,
    | "created_at"
    | "registered_at"
    | "attestation_mode"
    | "onchain_attestation_attempts"
    | "last_attestation_error"
    | "next_attempt_at"
  > & {
    registeredAt?: Date;
    attestation_mode?: string;
  },
): Promise<AgentRow> {
  const { rows } = await client.query<AgentRow>(
    `INSERT INTO agents (id, tenant_id, kind, role, display_name, scope_hash,
                         onchain_address, state, registered_tx, registered_at, attestation_mode)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
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
      // Explicit, matching the migration's DB-level default: never rely on an
      // implicit column-list omission to pick "onchain_custodial", since a
      // future caller that forgets this field must not silently mint a
      // tier-1 unattested agent.
      input.attestation_mode ?? "onchain_custodial",
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

/**
 * Promote a `pending_onchain` agent to `active` after its BrainMCPAgentRegistry
 * scope attestation confirms — recording the attestation tx hash. Conditional on
 * the row still being `pending_onchain` (idempotent: returns null if it isn't, so
 * a duplicate relay does not error or re-stamp). RFC 0002 Phase C.
 */
export async function markAgentRegistered(
  client: TenantScopedClient,
  id: string,
  txHash: string | null,
): Promise<AgentRow | null> {
  const { rows } = await client.query<AgentRow>(
    `UPDATE agents
        SET state = 'active', registered_tx = $2, registered_at = now()
      WHERE id = $1 AND state = 'pending_onchain'
      RETURNING *`,
    [id, txHash],
  );
  return rows[0] ?? null;
}

/** Cross-tenant query surface for the agent-registration worker's privileged connection. */
export type PrivilegedAgentClient = Pick<TenantScopedClient, "query">;

/**
 * Claim a batch of `pending_onchain` agents for on-chain attestation
 * (RFC 0002 Phase C, increment 3). Cross-tenant: run on a privileged
 * (BYPASSRLS `brain_execution_worker`) connection, mirroring
 * OutboxService.claimNext.
 *
 * `next_attempt_at` does double duty as both the retry backoff clock (see
 * markAgentAttestationFailed) and the claim lease: this single atomic
 * UPDATE ... RETURNING pushes it `leaseSeconds` into the future for every
 * claimed row, so a concurrent claim (or the next cycle, if this worker
 * crashes mid-row) naturally excludes it until the lease expires. No
 * separate locked_at/locked_by column, and no reclaim step, is needed.
 */
export async function claimPendingOnchainAgentsForAttestation(
  client: PrivilegedAgentClient,
  limit: number,
  maxAttempts: number,
  leaseSeconds = 300,
): Promise<Array<Pick<AgentRow, "id" | "tenant_id" | "onchain_attestation_attempts">>> {
  const { rows } = await client.query<
    Pick<AgentRow, "id" | "tenant_id" | "onchain_attestation_attempts">
  >(
    `UPDATE agents
        SET next_attempt_at = now() + ($4 || ' seconds')::interval
      WHERE id IN (
        SELECT id FROM agents
         WHERE state = 'pending_onchain'
           AND onchain_attestation_attempts < $2
           AND (next_attempt_at IS NULL OR next_attempt_at <= now())
         ORDER BY created_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id, tenant_id, onchain_attestation_attempts`,
    [limit, maxAttempts, leaseSeconds, leaseSeconds],
  );
  return rows;
}

/**
 * Insufficient relayer funds is never a permanent failure (matches
 * anchorBroadcaster.ts's InsufficientAnchorFundsError posture): release the
 * claim lease immediately without touching the attempt counter, so the row
 * is retried the next cycle rather than backing off or counting toward the
 * ceiling.
 */
export async function resetAgentAttestationLease(
  client: PrivilegedAgentClient,
  id: string,
): Promise<void> {
  await client.query(
    `UPDATE agents SET next_attempt_at = NULL WHERE id = $1 AND state = 'pending_onchain'`,
    [id],
  );
}

/**
 * Record an attestation failure: bump the attempt counter, store the error,
 * and set the next bounded-exponential-backoff claim window (same schedule
 * as OutboxService: baseSeconds * 2^(old attempts), capped). Returns the new
 * attempt count so the caller can detect the ceiling. `onchain_attestation_attempts`
 * on the right-hand side of the SET expression refers to the PRE-update value
 * (Postgres evaluates every SET expression against the old row), which is
 * exactly the exponent this schedule needs.
 */
export async function markAgentAttestationFailed(
  client: PrivilegedAgentClient,
  id: string,
  error: string,
  baseSeconds = 30,
  capSeconds = 480,
): Promise<number> {
  const { rows } = await client.query<{ onchain_attestation_attempts: number }>(
    `UPDATE agents
        SET onchain_attestation_attempts = onchain_attestation_attempts + 1,
            last_attestation_error = $2,
            next_attempt_at = now() + (LEAST($3 * power(2, onchain_attestation_attempts), $4) || ' seconds')::interval
      WHERE id = $1 AND state = 'pending_onchain'
      RETURNING onchain_attestation_attempts`,
    [id, error, baseSeconds, capSeconds],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`agent ${id} not in state pending_onchain`);
  return row.onchain_attestation_attempts;
}

/**
 * Terminal failure: the attestation attempt ceiling was reached. Transitions
 * pending_onchain -> failed (state-machines.ts already allows it) and records
 * the last error. Conditional on the row still being pending_onchain, same
 * idempotent-no-op posture as markAgentRegistered.
 */
export async function markAgentFailed(
  client: PrivilegedAgentClient,
  id: string,
  error: string,
): Promise<AgentRow | null> {
  assertAgentTransition("pending_onchain", "failed");
  const { rows } = await client.query<AgentRow>(
    `UPDATE agents
        SET state = 'failed', last_attestation_error = $2
      WHERE id = $1 AND state = 'pending_onchain'
      RETURNING *`,
    [id, error],
  );
  return rows[0] ?? null;
}

// ---------- users ----------

export interface UserRow {
  id: string;
  tenant_id: string;
  email: string;
  role: "owner" | "admin" | "approver" | "viewer";
  created_at: Date;
  status: "pending" | "active" | "disabled";
}

export async function findUser(client: TenantScopedClient, id: string): Promise<UserRow | null> {
  const { rows } = await client.query<UserRow>(`SELECT * FROM users WHERE id = $1 LIMIT 1`, [id]);
  return rows[0] ?? null;
}
