/**
 * audit_events + audit_anchors read-path + anchor-write helpers.
 * audit_events insertion lives in shared/audit/emitter (stage-1); this
 * module provides the read/query surface and the anchor write path.
 */

import type { TenantScopedClient } from "@brain/api/shared";

export interface AuditEventRow {
  id: string;
  tenant_id: string;
  layer: string;
  actor: string;
  action: string;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  policy_version: number | null;
  event_hash: Buffer;
  prev_event_hash: Buffer | null;
  created_at: Date;
}

export interface AuditQueryFilters {
  layer?: string;
  since?: Date;
  until?: Date;
  limit: number;
}

export async function queryEvents(
  client: TenantScopedClient,
  f: AuditQueryFilters,
): Promise<AuditEventRow[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  if (f.layer !== undefined) {
    values.push(f.layer);
    where.push(`layer = $${values.length}`);
  }
  if (f.since !== undefined) {
    values.push(f.since);
    where.push(`created_at >= $${values.length}`);
  }
  if (f.until !== undefined) {
    values.push(f.until);
    where.push(`created_at <= $${values.length}`);
  }
  values.push(f.limit);
  const limitIdx = values.length;
  const whereSql = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
  const { rows } = await client.query<AuditEventRow>(
    `SELECT * FROM audit_events ${whereSql} ORDER BY created_at DESC, id DESC LIMIT $${limitIdx}`,
    values,
  );
  return rows;
}

/**
 * Map an entity type to the audit event field(s) we expect to carry the
 * entity's id when an event touches it. The map is conservative — when
 * a new entity gets first-class audit references, add it here so the
 * /audit/entity/:type/:id endpoint can find events that reference it.
 */
const ENTITY_FIELD_MAP: Readonly<Record<string, ReadonlyArray<string>>> = {
  account: ["account_id"],
  balance: ["balance_id"],
  transaction: ["transaction_id"],
  counterparty: ["counterparty_id"],
  obligation: ["obligation_id"],
  document: ["document_id"],
  invoice: ["invoice_id"],
  payment_intent: ["payment_intent_id"],
  reconciliation_match: ["match_id"],
  proposal: ["proposal_id"],
  execution: ["execution_id"],
};

export const SUPPORTED_AUDIT_ENTITY_TYPES = Object.keys(ENTITY_FIELD_MAP);

/**
 * Find every audit event whose `inputs` or `outputs` JSONB carries the
 * given entity id under one of the entity-type-specific field names.
 *
 * Implementation note. We use `(inputs->>$field) = $id OR (outputs->>$field) = $id`
 * for each known field and OR them together. Postgres can index any of
 * these via expression indexes per-field; for MVP we accept the cost of
 * a small heap scan. The query is bounded by tenant via RLS + an
 * explicit LIMIT.
 */
export async function findEventsByEntity(
  client: TenantScopedClient,
  entityType: string,
  entityId: string,
  limit: number,
): Promise<AuditEventRow[]> {
  const fields = ENTITY_FIELD_MAP[entityType];
  if (fields === undefined || fields.length === 0) return [];

  // Build OR'd predicates across {inputs,outputs} × fields. Same value
  // ($1) reused for every predicate.
  const predicates: string[] = [];
  for (const field of fields) {
    predicates.push(`(inputs->>'${field}') = $1`);
    predicates.push(`(outputs->>'${field}') = $1`);
  }
  // payment_intent events also use `policy_decision_id` as a join key —
  // not strictly an entity field but useful for reconstruction.
  if (entityType === "payment_intent") {
    predicates.push(`policy_decision_id = $1`);
  }

  const { rows } = await client.query<AuditEventRow>(
    `SELECT * FROM audit_events
      WHERE ${predicates.join(" OR ")}
      ORDER BY created_at ASC, id ASC
      LIMIT $2`,
    [entityId, limit],
  );
  return rows;
}

export async function findEvent(client: TenantScopedClient, id: string): Promise<AuditEventRow | null> {
  const { rows } = await client.query<AuditEventRow>(
    `SELECT * FROM audit_events WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function listEventsForAnchor(
  client: TenantScopedClient,
  periodStart: Date,
  periodEnd: Date,
): Promise<AuditEventRow[]> {
  const { rows } = await client.query<AuditEventRow>(
    `SELECT * FROM audit_events
       WHERE created_at >= $1 AND created_at <= $2
       ORDER BY created_at ASC, id ASC`,
    [periodStart, periodEnd],
  );
  return rows;
}

// ---------- anchors ----------

export interface AuditAnchorRow {
  id: string;
  tenant_id: string;
  merkle_root: Buffer;
  event_count: number;
  period_start: Date;
  period_end: Date;
  onchain_tx_hash: Buffer | null;
  onchain_block_number: string | null;
  created_at: Date;
}

export async function insertAnchor(
  client: TenantScopedClient,
  input: {
    id: string;
    tenantId: string;
    merkleRoot: Buffer;
    eventCount: number;
    periodStart: Date;
    periodEnd: Date;
  },
): Promise<AuditAnchorRow> {
  const { rows } = await client.query<AuditAnchorRow>(
    `INSERT INTO audit_anchors (id, tenant_id, merkle_root, event_count, period_start, period_end)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING *`,
    [
      input.id,
      input.tenantId,
      input.merkleRoot,
      input.eventCount,
      input.periodStart,
      input.periodEnd,
    ],
  );
  const row = rows[0];
  if (row === undefined) throw new Error("audit_anchors insert returned no row");
  return row;
}

export async function findLatestAnchor(client: TenantScopedClient): Promise<AuditAnchorRow | null> {
  const { rows } = await client.query<AuditAnchorRow>(
    `SELECT * FROM audit_anchors ORDER BY period_end DESC LIMIT 1`,
  );
  return rows[0] ?? null;
}

export async function findAnchorByRoot(
  client: TenantScopedClient,
  root: Buffer,
): Promise<AuditAnchorRow | null> {
  const { rows } = await client.query<AuditAnchorRow>(
    `SELECT * FROM audit_anchors WHERE merkle_root = $1 LIMIT 1`,
    [root],
  );
  return rows[0] ?? null;
}

export async function setAnchorTxHash(
  client: TenantScopedClient,
  id: string,
  txHash: Buffer,
  blockNumber: bigint,
): Promise<void> {
  await client.query(
    `UPDATE audit_anchors SET onchain_tx_hash = $1, onchain_block_number = $2 WHERE id = $3`,
    [txHash, blockNumber.toString(), id],
  );
}
