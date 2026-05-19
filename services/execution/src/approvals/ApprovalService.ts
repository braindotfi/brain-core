/**
 * ApprovalService — implementation of IApprovalService.
 *
 * Stores approvals in the `approvals` table (services/execution owns the
 * schema). Quorum is computed by counting unique approver_role values
 * matched against a required-role list.
 *
 * Re-signing by the same principal is a no-op; signing a NEW principal
 * for the same subject creates a fresh row.
 */

import {
  newApprovalId,
  withTenantScope,
  type ApprovalRecord,
  type AuditEmitter,
  type IApprovalService,
  type ServiceCallContext,
} from "@brain/shared";
import type { Pool } from "pg";
import { insertApproval, listApprovals, type ApprovalSubjectType } from "./repository.js";

export interface ApprovalServiceDeps {
  pool: Pool;
  audit: AuditEmitter;
  /** Resolves a principal id to a role (e.g. cfo, ceo). Caller-supplied so
   *  the auth/role model lives at the API boundary, not in this service. */
  resolveRole: (ctx: ServiceCallContext, principalId: string) => Promise<string | null>;
}

export class ApprovalService implements IApprovalService {
  public constructor(private readonly deps: ApprovalServiceDeps) {}

  public async sign(
    ctx: ServiceCallContext,
    subject: { type: "payment_intent" | "proposal"; id: string },
    role?: string,
    signature?: string,
  ): Promise<ApprovalRecord> {
    const resolvedRole = role ?? (await this.deps.resolveRole(ctx, ctx.actor)) ?? null;
    const result = await withTenantScope(this.deps.pool, ctx.tenantId, (c) =>
      insertApproval(c, {
        id: newApprovalId(),
        tenantId: ctx.tenantId,
        subjectType: subject.type,
        subjectId: subject.id,
        approverPrincipalId: ctx.actor,
        approverRole: resolvedRole,
        signature: signature ?? null,
      }),
    );

    if (result.created) {
      await this.deps.audit.emit({
        tenantId: ctx.tenantId,
        layer: "agent",
        actor: ctx.actor,
        action: `approval.${subject.type}.signed`,
        inputs: {
          subject_type: subject.type,
          subject_id: subject.id,
          approver_role: resolvedRole,
        },
        outputs: { approval_id: result.row.id },
      });
    }

    return toRecord(result.row);
  }

  public async list(
    ctx: ServiceCallContext,
    subject: { type: "payment_intent" | "proposal"; id: string },
  ): Promise<ApprovalRecord[]> {
    const rows = await withTenantScope(this.deps.pool, ctx.tenantId, (c) =>
      listApprovals(c, subject.type as ApprovalSubjectType, subject.id),
    );
    return rows.map(toRecord);
  }

  public async hasRequiredApprovals(
    ctx: ServiceCallContext,
    subject: { type: "payment_intent" | "proposal"; id: string },
    requiredRoles: string[],
  ): Promise<boolean> {
    if (requiredRoles.length === 0) return true;
    const rows = await withTenantScope(this.deps.pool, ctx.tenantId, (c) =>
      listApprovals(c, subject.type as ApprovalSubjectType, subject.id),
    );
    const signed = new Set(rows.map((r) => r.approver_role).filter((r): r is string => r !== null));
    return requiredRoles.every((r) => signed.has(r));
  }

  /** Convenience for the §6 gate. Returns just the signed roles. */
  public async signedRoles(
    ctx: ServiceCallContext,
    subject: { type: "payment_intent" | "proposal"; id: string },
  ): Promise<string[]> {
    const rows = await withTenantScope(this.deps.pool, ctx.tenantId, (c) =>
      listApprovals(c, subject.type as ApprovalSubjectType, subject.id),
    );
    return rows.map((r) => r.approver_role).filter((r): r is string => r !== null);
  }
}

function toRecord(row: {
  id: string;
  subject_type: string;
  subject_id: string;
  approver_principal_id: string;
  approver_role: string | null;
  signed_at: Date;
  signature: string | null;
}): ApprovalRecord {
  return {
    id: row.id,
    subject_type: row.subject_type as ApprovalRecord["subject_type"],
    subject_id: row.subject_id,
    approver_principal_id: row.approver_principal_id,
    approver_role: row.approver_role,
    signed_at: row.signed_at.toISOString(),
    signature: row.signature,
  };
}
