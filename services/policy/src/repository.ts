/**
 * policies repository + §8.3 state machine enforcement.
 *
 * Transitions allowed:
 *   draft              → pending_signatures | cancelled
 *   pending_signatures → active | expired
 *   active             → deactivated
 * No other transitions succeed — the helper throws
 * execution_proposal_invalid_state (we reuse the execution state-machine
 * error code rather than invent a new one; the semantics match).
 */

import type { TenantScopedClient } from "@brain/shared";
import { brainError } from "@brain/shared";
import { contentHashHex, type PolicyDocument } from "./dsl.js";

export type PolicyState =
  | "draft"
  | "pending_signatures"
  | "active"
  | "deactivated"
  | "cancelled"
  | "expired";

export interface PolicyRow {
  id: string;
  tenant_id: string;
  version: number;
  content: PolicyDocument;
  content_hash: Buffer;
  signers: Array<{ address: string; signature: string }> | null;
  state: PolicyState;
  quorum_required: number;
  activated_at: Date | null;
  deactivated_at: Date | null;
  created_by: string;
  created_at: Date;
}

export interface InsertPolicyInput {
  id: string;
  tenantId: string;
  version: number;
  content: PolicyDocument;
  contentHash: Buffer;
  quorumRequired: number;
  createdBy: string;
  state: PolicyState;
}

export async function insertPolicy(
  client: TenantScopedClient,
  input: InsertPolicyInput,
): Promise<PolicyRow> {
  const { rows } = await client.query<PolicyRow>(
    `INSERT INTO policies
       (id, tenant_id, version, content, content_hash, quorum_required, state, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      input.id,
      input.tenantId,
      input.version,
      JSON.stringify(input.content),
      input.contentHash,
      input.quorumRequired,
      input.state,
      input.createdBy,
    ],
  );
  const row = rows[0];
  if (row === undefined) throw new Error("policies insert returned no row");
  return row;
}

/**
 * Load the tenant's active policy row, then re-verify it before returning.
 *
 * This is the read-side half of the signature chain: composing and signing a
 * policy proves the content is what a quorum of authorized signers approved,
 * but that proof is only ever checked at write time. Nothing today re-checks,
 * on read, that `content` still hashes to the stored `content_hash` -- so a
 * direct DB write, a bad migration, or a restore that mutates `content` after
 * activation would silently hand the section 6 gate an unsigned document that
 * the gate then enforces as authoritative.
 *
 * On a hash mismatch this THROWS rather than returning null. Returning null
 * would read as "tenant has no active policy", and PolicyService.evaluateForGate
 * turns that into policy_not_found -- a misleading diagnosis for a tamper or
 * corruption event, and one that could tempt a caller to fall back to some
 * default instead of denying. Throwing a distinct error propagates out of
 * evaluateForGate untouched, so the gate denies the action instead of
 * evaluating a document nobody actually signed. This function must never be
 * changed to degrade the mismatch case to null.
 */
export async function getActive(client: TenantScopedClient): Promise<PolicyRow | null> {
  const { rows } = await client.query<PolicyRow>(
    `SELECT * FROM policies WHERE state = 'active' LIMIT 1`,
  );
  const row = rows[0];
  if (row === undefined) return null;

  const recomputed = contentHashHex(row.content);
  const stored = Buffer.from(row.content_hash).toString("hex");
  if (recomputed !== stored) {
    throw brainError("policy_not_active", "active policy content_hash does not match content", {
      details: { policy_id: row.id, stored_hash: stored, recomputed_hash: recomputed },
    });
  }
  return row;
}

export async function getById(client: TenantScopedClient, id: string): Promise<PolicyRow | null> {
  const { rows } = await client.query<PolicyRow>(`SELECT * FROM policies WHERE id = $1 LIMIT 1`, [
    id,
  ]);
  return rows[0] ?? null;
}

export async function getByVersion(
  client: TenantScopedClient,
  version: number,
): Promise<PolicyRow | null> {
  const { rows } = await client.query<PolicyRow>(
    `SELECT * FROM policies WHERE version = $1 LIMIT 1`,
    [version],
  );
  return rows[0] ?? null;
}

export async function listVersions(client: TenantScopedClient): Promise<PolicyRow[]> {
  const { rows } = await client.query<PolicyRow>(`SELECT * FROM policies ORDER BY version DESC`);
  return rows;
}

export async function setSigners(
  client: TenantScopedClient,
  id: string,
  signers: Array<{ address: string; signature: string }>,
): Promise<void> {
  await client.query(`UPDATE policies SET signers = $1 WHERE id = $2`, [
    JSON.stringify(signers),
    id,
  ]);
}

export async function transition(
  client: TenantScopedClient,
  id: string,
  from: PolicyState,
  to: PolicyState,
): Promise<PolicyRow> {
  if (!isValidTransition(from, to)) {
    throw brainError(
      "execution_proposal_invalid_state",
      `invalid policy state transition ${from} → ${to}`,
    );
  }

  // Activating N+1 deactivates any currently active row atomically.
  if (to === "active") {
    await client.query(
      `UPDATE policies SET state = 'deactivated', deactivated_at = now() WHERE state = 'active'`,
    );
  }

  const activatedAtClause = to === "active" ? ", activated_at = now()" : "";
  const { rows } = await client.query<PolicyRow>(
    `UPDATE policies SET state = $1${activatedAtClause}
       WHERE id = $2 AND state = $3
       RETURNING *`,
    [to, id, from],
  );
  const row = rows[0];
  if (row === undefined) {
    throw brainError("execution_proposal_invalid_state", `policy ${id} is not in state ${from}`);
  }
  return row;
}

export function isValidTransition(from: PolicyState, to: PolicyState): boolean {
  switch (from) {
    case "draft":
      return to === "pending_signatures" || to === "cancelled";
    case "pending_signatures":
      return to === "active" || to === "expired";
    case "active":
      return to === "deactivated";
    case "deactivated":
    case "cancelled":
    case "expired":
      return false;
  }
}
