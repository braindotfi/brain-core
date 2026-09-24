import type { TenantScopedClient } from "@brain/shared";

export type EvidenceKind = "pdf" | "record" | "mail" | "image" | "external" | "report" | "data";
export type EvidenceSource = "uploaded" | "emailed" | "synced" | "generated" | "external_link";
export type EvidenceRetentionClass = "standard" | "compliance_7yr" | "permanent";

export interface EvidenceRecord {
  id: string;
  tenantId: string;
  kind: EvidenceKind;
  name: string;
  source: EvidenceSource;
  storageRef: string;
  sha256: string | null;
  mimeType: string;
  byteSize: bigint;
  capturedAt: Date;
  capturedBy: string;
  retentionClass: EvidenceRetentionClass;
  metadata: Record<string, unknown>;
  archivedAt: Date | null;
  deletedAt: Date | null;
  deleteReason: string | null;
  createdAt: Date;
}

export interface InsertEvidenceInput {
  id: string;
  tenantId: string;
  kind: EvidenceKind;
  name: string;
  source: EvidenceSource;
  storageRef: string;
  sha256: string | null;
  mimeType: string;
  byteSize: bigint;
  capturedAt: Date;
  capturedBy: string;
  retentionClass: EvidenceRetentionClass;
  metadata: Record<string, unknown>;
}

export interface EvidenceListFilters {
  proposalId?: string;
  kind?: EvidenceKind;
  from?: Date;
  to?: Date;
  includeDeleted?: boolean;
  limit: number;
}

interface EvidenceRow {
  id: string;
  tenant_id: string;
  kind: EvidenceKind;
  name: string;
  source: EvidenceSource;
  storage_ref: string;
  sha256: string | null;
  mime_type: string;
  byte_size: string | number | bigint;
  captured_at: Date;
  captured_by: string;
  retention_class: EvidenceRetentionClass;
  metadata: Record<string, unknown>;
  archived_at: Date | null;
  deleted_at: Date | null;
  delete_reason: string | null;
  created_at: Date;
}

export async function insertEvidence(
  client: TenantScopedClient,
  input: InsertEvidenceInput,
): Promise<EvidenceRecord> {
  const { rows } = await client.query<EvidenceRow>(
    `INSERT INTO evidence (
       id, tenant_id, kind, name, source, storage_ref, sha256, mime_type,
       byte_size, captured_at, captured_by, retention_class, metadata
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
     RETURNING *`,
    [
      input.id,
      input.tenantId,
      input.kind,
      input.name,
      input.source,
      input.storageRef,
      input.sha256,
      input.mimeType,
      input.byteSize.toString(),
      input.capturedAt,
      input.capturedBy,
      input.retentionClass,
      JSON.stringify(input.metadata),
    ],
  );
  const row = rows[0];
  if (row === undefined) throw new Error("evidence insert returned no row");
  return evidenceFromRow(row);
}

export async function findEvidenceById(
  client: TenantScopedClient,
  id: string,
): Promise<EvidenceRecord | null> {
  const { rows } = await client.query<EvidenceRow>(
    `SELECT *
       FROM evidence
      WHERE id = $1
        AND tenant_id = current_setting('app.tenant_id', true)
      LIMIT 1`,
    [id],
  );
  return rows[0] === undefined ? null : evidenceFromRow(rows[0]);
}

export async function listEvidence(
  client: TenantScopedClient,
  filters: EvidenceListFilters,
): Promise<EvidenceRecord[]> {
  const values: unknown[] = [];
  const where = [`e.tenant_id = current_setting('app.tenant_id', true)`];
  let join = "";
  if (filters.proposalId !== undefined) {
    values.push(filters.proposalId);
    join = `JOIN proposal_evidence_links pel
              ON pel.tenant_id = e.tenant_id
             AND pel.evidence_id = e.id`;
    where.push(`pel.proposal_id = $${values.length}`);
  }
  if (filters.kind !== undefined) {
    values.push(filters.kind);
    where.push(`e.kind = $${values.length}`);
  }
  if (filters.from !== undefined) {
    values.push(filters.from);
    where.push(`e.captured_at >= $${values.length}`);
  }
  if (filters.to !== undefined) {
    values.push(filters.to);
    where.push(`e.captured_at <= $${values.length}`);
  }
  if (filters.includeDeleted !== true) {
    where.push(`e.deleted_at IS NULL`);
  }
  values.push(filters.limit);
  const { rows } = await client.query<EvidenceRow>(
    `SELECT e.*
       FROM evidence e
       ${join}
      WHERE ${where.join(" AND ")}
      ORDER BY e.captured_at DESC, e.id DESC
      LIMIT $${values.length}`,
    values,
  );
  return rows.map(evidenceFromRow);
}

export async function linkEvidenceToProposal(
  client: TenantScopedClient,
  input: {
    tenantId: string;
    proposalId: string;
    evidenceId: string;
    sourceRef?: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO proposal_evidence_links (tenant_id, proposal_id, evidence_id, source_ref)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT DO NOTHING`,
    [input.tenantId, input.proposalId, input.evidenceId, JSON.stringify(input.sourceRef ?? {})],
  );
}

export async function hasOpenProposalAttachment(
  client: TenantScopedClient,
  evidenceId: string,
): Promise<boolean> {
  const { rows } = await client.query<{ found: number }>(
    `SELECT 1 AS found
       FROM proposal_evidence_links pel
       JOIN proposals p
         ON p.tenant_id = pel.tenant_id
        AND p.id = pel.proposal_id
      WHERE pel.tenant_id = current_setting('app.tenant_id', true)
        AND pel.evidence_id = $1
        AND p.decision IS NULL
        AND p.status NOT IN ('rejected', 'executed', 'failed', 'undone', 'superseded', 'blocked')
      LIMIT 1`,
    [evidenceId],
  );
  return rows[0] !== undefined;
}

export async function softDeleteEvidence(
  client: TenantScopedClient,
  id: string,
  reason: string,
): Promise<EvidenceRecord | null> {
  const { rows } = await client.query<EvidenceRow>(
    `UPDATE evidence
        SET deleted_at = COALESCE(deleted_at, now()),
            delete_reason = COALESCE(delete_reason, $2)
      WHERE id = $1
        AND tenant_id = current_setting('app.tenant_id', true)
      RETURNING *`,
    [id, reason],
  );
  return rows[0] === undefined ? null : evidenceFromRow(rows[0]);
}

export async function archiveExpiredStandardEvidence(
  client: TenantScopedClient,
  now: Date,
): Promise<number> {
  const result = await client.query(
    `UPDATE evidence e
        SET archived_at = $1
      WHERE e.tenant_id = current_setting('app.tenant_id', true)
        AND e.retention_class = 'standard'
        AND e.archived_at IS NULL
        AND e.deleted_at IS NULL
        AND (
          EXISTS (
            SELECT 1
              FROM proposal_evidence_links pel
              JOIN proposals p
                ON p.tenant_id = pel.tenant_id
               AND p.id = pel.proposal_id
             WHERE pel.tenant_id = e.tenant_id
               AND pel.evidence_id = e.id
               AND p.decided_at IS NOT NULL
               AND p.decided_at <= $1::timestamptz - interval '90 days'
          )
          OR (
            NOT EXISTS (
              SELECT 1
                FROM proposal_evidence_links pel
               WHERE pel.tenant_id = e.tenant_id
                 AND pel.evidence_id = e.id
            )
            AND e.captured_at <= $1::timestamptz - interval '90 days'
          )
        )`,
    [now],
  );
  return result.rowCount ?? 0;
}

function evidenceFromRow(row: EvidenceRow): EvidenceRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    kind: row.kind,
    name: row.name,
    source: row.source,
    storageRef: row.storage_ref,
    sha256: row.sha256,
    mimeType: row.mime_type,
    byteSize: BigInt(row.byte_size),
    capturedAt: row.captured_at,
    capturedBy: row.captured_by,
    retentionClass: row.retention_class,
    metadata: row.metadata,
    archivedAt: row.archived_at,
    deletedAt: row.deleted_at,
    deleteReason: row.delete_reason,
    createdAt: row.created_at,
  };
}
