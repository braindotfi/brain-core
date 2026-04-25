/**
 * approvals table — repository.
 *
 * Schema lives in services/execution/migrations/0004_approvals.sql.
 * Approvals are tenant-scoped and unique per (subject, principal).
 */

import type { TenantScopedClient } from "@brain/api/shared";

export type ApprovalSubjectType = "payment_intent" | "proposal";

export interface ApprovalRow {
  id: string;
  tenant_id: string;
  subject_type: ApprovalSubjectType;
  subject_id: string;
  approver_principal_id: string;
  approver_role: string | null;
  signed_at: Date;
  signature: string | null;
}

export interface InsertApprovalInput {
  id: string;
  tenantId: string;
  subjectType: ApprovalSubjectType;
  subjectId: string;
  approverPrincipalId: string;
  approverRole: string | null;
  signature: string | null;
}

/**
 * Idempotent insert: re-signing by the same principal is a no-op (returns
 * the existing row).
 */
export async function insertApproval(
  client: TenantScopedClient,
  input: InsertApprovalInput,
): Promise<{ row: ApprovalRow; created: boolean }> {
  const { rows: existing } = await client.query<ApprovalRow>(
    `SELECT * FROM approvals
      WHERE subject_type = $1 AND subject_id = $2 AND approver_principal_id = $3
      LIMIT 1`,
    [input.subjectType, input.subjectId, input.approverPrincipalId],
  );
  if (existing[0] !== undefined) {
    return { row: existing[0], created: false };
  }
  const { rows } = await client.query<ApprovalRow>(
    `INSERT INTO approvals
       (id, tenant_id, subject_type, subject_id, approver_principal_id, approver_role, signature)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      input.id,
      input.tenantId,
      input.subjectType,
      input.subjectId,
      input.approverPrincipalId,
      input.approverRole,
      input.signature,
    ],
  );
  const row = rows[0];
  if (row === undefined) throw new Error("approvals insert returned no row");
  return { row, created: true };
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
