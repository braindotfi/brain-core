/**
 * IAuditService — Layer 6 boundary contract.
 *
 * Owns the append-only event log and Merkle-anchored proof. Read-side
 * exposes querying and inclusion proofs; write-side is internal — every
 * other service emits via emit() and never queries the table directly.
 *
 * Layer boundary invariants:
 *  - audit_events is append-only. No UPDATE, no DELETE.
 *  - Every material state change in the system creates one event.
 *  - The audit-before / audit-after pair around any payment execution is
 *    non-skippable per §6.
 *  - /audit/verify is public (skipAuth) and is a pure inclusion verifier.
 */

import type { ServiceCallContext } from "./types.js";

export interface AuditEventInput {
  layer: "raw" | "ledger" | "wiki" | "policy" | "agent" | "audit";
  action: string; // e.g. "ledger.transaction.posted"
  actor: string;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  policy_version?: number;
  policy_decision_id?: string;
  before_state?: Record<string, unknown>;
  after_state?: Record<string, unknown>;
}

export interface AuditEventRecord extends AuditEventInput {
  id: string;
  tenant_id: string;
  event_hash: string;
  prev_event_hash: string | null;
  created_at: string;
}

export interface AuditAnchorRecord {
  id: string;
  merkle_root: string;
  event_count: number;
  period_start: string;
  period_end: string;
  onchain_tx_hash: string | null;
  onchain_block_number: number | null;
  created_at: string;
}

export interface IAuditService {
  /** Append a new audit event. Emits the on-tenant Merkle hash chain. */
  emit(ctx: ServiceCallContext, input: AuditEventInput): Promise<AuditEventRecord>;

  query(
    ctx: ServiceCallContext,
    f: { layer?: AuditEventInput["layer"]; since?: string; until?: string; limit?: number },
  ): Promise<AuditEventRecord[]>;

  getEvent(
    ctx: ServiceCallContext,
    id: string,
  ): Promise<{
    event: AuditEventRecord;
    inclusion_proof: string[];
    merkle_root: string | null;
    anchor_id: string | null;
  } | null>;

  /** Every event touching a Ledger row, by entity type. */
  entityHistory(
    ctx: ServiceCallContext,
    entityType: string,
    entityId: string,
  ): Promise<AuditEventRecord[]>;

  latestAnchor(ctx: ServiceCallContext): Promise<AuditAnchorRecord | null>;

  /** Pure verifier — public endpoint. Does not require ServiceCallContext. */
  verifyInclusion(rootHex: string, leafHex: string, proofHex: string[]): Promise<boolean>;
}
