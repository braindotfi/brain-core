/**
 * approvals table — repository.
 *
 * Schema lives in services/execution/migrations/0004_approvals.sql.
 * Approvals are tenant-scoped and unique per (subject, principal).
 */

import type { TenantScopedClient } from "@brain/shared";

export type ApprovalSubjectType = "payment_intent" | "proposal";

export type ApprovalStatus = "valid" | "stale" | "revoked";

export interface ApprovalRow {
  id: string;
  tenant_id: string;
  subject_type: ApprovalSubjectType;
  subject_id: string;
  approver_principal_id: string;
  approver_role: string | null;
  signed_at: Date;
  signature: string | null;
  // P0.4 hardening columns.
  policy_version: number | null;
  revoked_at: Date | null;
  signer_tenant_id: string | null;
  status: ApprovalStatus;
}

export interface InsertApprovalInput {
  id: string;
  tenantId: string;
  subjectType: ApprovalSubjectType;
  subjectId: string;
  approverPrincipalId: string;
  approverRole: string | null;
  signature: string | null;
  /** P0.4: tenant policy version active at signing (null = legacy/unknown). */
  policyVersion: number | null;
  /** P0.4: denormalized signer tenant (for the cross-tenant guard). */
  signerTenantId: string;
}

/** Look up an existing signature by (subject, signer) — used for duplicate detection. */
export async function findApprovalForSigner(
  client: TenantScopedClient,
  subjectType: ApprovalSubjectType,
  subjectId: string,
  principalId: string,
): Promise<ApprovalRow | null> {
  const { rows } = await client.query<ApprovalRow>(
    `SELECT * FROM approvals
      WHERE subject_type = $1 AND subject_id = $2 AND approver_principal_id = $3
      LIMIT 1`,
    [subjectType, subjectId, principalId],
  );
  return rows[0] ?? null;
}

/**
 * Insert a fresh signature. Duplicate detection (one signature per
 * (subject, signer)) is the caller's responsibility — ApprovalService rejects a
 * duplicate with approval_duplicate_signer BEFORE calling this. The UNIQUE
 * constraint remains the backstop.
 */
export async function insertApproval(
  client: TenantScopedClient,
  input: InsertApprovalInput,
): Promise<ApprovalRow> {
  const { rows } = await client.query<ApprovalRow>(
    `INSERT INTO approvals
       (id, tenant_id, subject_type, subject_id, approver_principal_id, approver_role,
        signature, policy_version, signer_tenant_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'valid')
     RETURNING *`,
    [
      input.id,
      input.tenantId,
      input.subjectType,
      input.subjectId,
      input.approverPrincipalId,
      input.approverRole,
      input.signature,
      input.policyVersion,
      input.signerTenantId,
    ],
  );
  const row = rows[0];
  if (row === undefined) throw new Error("approvals insert returned no row");
  return row;
}

export async function listApprovals(
  client: TenantScopedClient,
  subjectType: ApprovalSubjectType,
  subjectId: string,
): Promise<ApprovalRow[]> {
  const { rows } = await client.query<ApprovalRow>(
    `SELECT * FROM approvals
      WHERE subject_type = $1 AND subject_id = $2
      ORDER BY signed_at ASC`,
    [subjectType, subjectId],
  );
  return rows;
}

/**
 * P0.4: invalidate any currently-valid signature whose policy_version is not the
 * active version. Returns the number of rows marked stale. A NULL policy_version
 * (legacy row) is left untouched so pre-P0.4 approvals still count.
 */
export async function markStaleForSupersededVersion(
  client: TenantScopedClient,
  subjectType: ApprovalSubjectType,
  subjectId: string,
  activeVersion: number,
): Promise<number> {
  const { rowCount } = await client.query(
    `UPDATE approvals
        SET status = 'stale'
      WHERE subject_type = $1 AND subject_id = $2
        AND status = 'valid'
        AND policy_version IS NOT NULL
        AND policy_version <> $3`,
    [subjectType, subjectId, activeVersion],
  );
  return rowCount ?? 0;
}

/**
 * P0.4: signatures that count toward quorum — status='valid', not revoked, and
 * (when an active version is supplied) matching that version or legacy-NULL.
 */
export async function listValidApprovals(
  client: TenantScopedClient,
  subjectType: ApprovalSubjectType,
  subjectId: string,
  activeVersion: number | null,
): Promise<ApprovalRow[]> {
  const { rows } = await client.query<ApprovalRow>(
    `SELECT * FROM approvals
      WHERE subject_type = $1 AND subject_id = $2
        AND status = 'valid'
        AND revoked_at IS NULL
        AND ($3::int IS NULL OR policy_version IS NULL OR policy_version = $3)
      ORDER BY signed_at ASC`,
    [subjectType, subjectId, activeVersion],
  );
  return rows;
}
