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
  brainError,
  newApprovalId,
  withTenantScope,
  type ApprovalRecord,
  type AuditEmitter,
  type IApprovalService,
  type ServiceCallContext,
} from "@brain/shared";
import type { Pool } from "pg";
import {
  findApprovalForSigner,
  insertApproval,
  listApprovals,
  listValidApprovals,
  markStaleForSupersededVersion,
  type ApprovalSubjectType,
} from "./repository.js";

export type ApprovalSubject = { type: ApprovalSubjectType; id: string };

export interface ApprovalServiceDeps {
  pool: Pool;
  audit: AuditEmitter;
  /** Resolves a principal id to a role (e.g. cfo, ceo). Caller-supplied so
   *  the auth/role model lives at the API boundary, not in this service. */
  resolveRole: (ctx: ServiceCallContext, principalId: string) => Promise<string | null>;
  /**
   * P0.4: true iff the signer principal is still an active approver (not
   * revoked). Resolved against the users/agents table at the API boundary.
   * Absent ⇒ the revocation guard is skipped (back-compat / tests).
   */
  isApproverActive?: (ctx: ServiceCallContext, principalId: string) => Promise<boolean>;
  /**
   * P0.4: owning tenant of the approval subject (the intent/proposal). The gate
   * rejects a signature whose signer tenant (ctx.tenantId) differs. Absent ⇒
   * the cross-tenant guard is skipped (RLS remains the backstop).
   */
  resolveSubjectOwnerTenant?: (
    ctx: ServiceCallContext,
    subject: ApprovalSubject,
  ) => Promise<string | null>;
  /**
   * P0.4: the tenant policy version active *now*. Recorded on each signature so
   * the gate can invalidate signatures made against a superseded version.
   * Absent ⇒ null is recorded (no staleness tracking).
   */
  resolveActivePolicyVersion?: (ctx: ServiceCallContext) => Promise<number | null>;
}

export class ApprovalService implements IApprovalService {
  public constructor(private readonly deps: ApprovalServiceDeps) {}

  public async sign(
    ctx: ServiceCallContext,
    subject: { type: "payment_intent" | "proposal"; id: string },
    role?: string,
    signature?: string,
  ): Promise<ApprovalRecord> {
    // P0.4 — guard the signer BEFORE writing anything.
    // (1) Revoked signer: a principal who has lost approver standing cannot sign.
    if (this.deps.isApproverActive !== undefined) {
      const active = await this.deps.isApproverActive(ctx, ctx.actor);
      if (!active) {
        throw brainError("approval_signer_revoked", "signer is not an active approver", {
          details: { signer_id: ctx.actor },
        });
      }
    }
    // (2) Cross-tenant signer: signer's tenant must own the subject.
    if (this.deps.resolveSubjectOwnerTenant !== undefined) {
      const ownerTenant = await this.deps.resolveSubjectOwnerTenant(ctx, subject);
      if (ownerTenant !== null && ownerTenant !== ctx.tenantId) {
        throw brainError("approval_cross_tenant", "signer tenant does not own this subject", {
          details: { signer_tenant: ctx.tenantId, owner_tenant: ownerTenant },
        });
      }
    }
    // (3) Policy version active at signing — recorded so the gate can stale it.
    const policyVersion =
      this.deps.resolveActivePolicyVersion !== undefined
        ? await this.deps.resolveActivePolicyVersion(ctx)
        : null;

    const resolvedRole = role ?? (await this.deps.resolveRole(ctx, ctx.actor)) ?? null;
    const row = await withTenantScope(this.deps.pool, ctx.tenantId, async (c) => {
      // (4) Duplicate signer: one signature per (subject, signer) — hard reject
      // (previously a silent no-op; changed for P0.4 hardening).
      const existing = await findApprovalForSigner(c, subject.type, subject.id, ctx.actor);
      if (existing !== null) {
        throw brainError("approval_duplicate_signer", "principal has already signed this subject", {
          details: { signer_id: ctx.actor, existing_approval_id: existing.id },
        });
      }
      return insertApproval(c, {
        id: newApprovalId(),
        tenantId: ctx.tenantId,
        subjectType: subject.type,
        subjectId: subject.id,
        approverPrincipalId: ctx.actor,
        approverRole: resolvedRole,
        signature: signature ?? null,
        policyVersion,
        signerTenantId: ctx.tenantId,
      });
    });

    await this.deps.audit.emit({
      tenantId: ctx.tenantId,
      layer: "agent",
      actor: ctx.actor,
      action: `approval.${subject.type}.signed`,
      inputs: {
        subject_type: subject.type,
        subject_id: subject.id,
        approver_role: resolvedRole,
        policy_version: policyVersion,
      },
      outputs: { approval_id: row.id },
    });

    return toRecord(row);
  }

  public async signAndCheckRequiredApprovals(
    ctx: ServiceCallContext,
    subject: { type: "payment_intent" | "proposal"; id: string },
    requiredRoles: readonly string[],
    role?: string,
    signature?: string,
  ): Promise<{ approval: ApprovalRecord; quorumMet: boolean }> {
    if (this.deps.isApproverActive !== undefined) {
      const active = await this.deps.isApproverActive(ctx, ctx.actor);
      if (!active) {
        throw brainError("approval_signer_revoked", "signer is not an active approver", {
          details: { signer_id: ctx.actor },
        });
      }
    }
    if (this.deps.resolveSubjectOwnerTenant !== undefined) {
      const ownerTenant = await this.deps.resolveSubjectOwnerTenant(ctx, subject);
      if (ownerTenant !== null && ownerTenant !== ctx.tenantId) {
        throw brainError("approval_cross_tenant", "signer tenant does not own this subject", {
          details: { signer_tenant: ctx.tenantId, owner_tenant: ownerTenant },
        });
      }
    }

    const policyVersion =
      this.deps.resolveActivePolicyVersion !== undefined
        ? await this.deps.resolveActivePolicyVersion(ctx)
        : null;
    const resolvedRole = role ?? (await this.deps.resolveRole(ctx, ctx.actor)) ?? null;
    let inserted = false;

    const { row, quorumMet } = await withTenantScope(this.deps.pool, ctx.tenantId, async (c) => {
      await c.query(
        "SELECT pg_advisory_xact_lock(('x' || substr(md5($1), 1, 16))::bit(64)::bigint)",
        [`${ctx.tenantId}:${subject.type}:${subject.id}`],
      );

      const existing = await findApprovalForSigner(c, subject.type, subject.id, ctx.actor);
      const approvalRow =
        existing ??
        (await insertApproval(c, {
          id: newApprovalId(),
          tenantId: ctx.tenantId,
          subjectType: subject.type,
          subjectId: subject.id,
          approverPrincipalId: ctx.actor,
          approverRole: resolvedRole,
          signature: signature ?? null,
          policyVersion,
          signerTenantId: ctx.tenantId,
        }));
      inserted = existing === null;

      if (policyVersion !== null) {
        await markStaleForSupersededVersion(
          c,
          subject.type as ApprovalSubjectType,
          subject.id,
          policyVersion,
        );
      }
      const rows = await listValidApprovals(
        c,
        subject.type as ApprovalSubjectType,
        subject.id,
        policyVersion,
      );
      const signed = new Set(
        rows.map((r) => r.approver_role).filter((r): r is string => r !== null),
      );
      return {
        row: approvalRow,
        quorumMet: hasRequiredRoleQuorum(requiredRoles, signed),
      };
    });

    if (inserted) {
      await this.deps.audit.emit({
        tenantId: ctx.tenantId,
        layer: "agent",
        actor: ctx.actor,
        action: `approval.${subject.type}.signed`,
        inputs: {
          subject_type: subject.type,
          subject_id: subject.id,
          approver_role: resolvedRole,
          policy_version: policyVersion,
        },
        outputs: { approval_id: row.id },
      });
    }

    return { approval: toRecord(row), quorumMet };
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
    // P0.4: only currently-valid (not stale / not revoked) signatures count.
    const roles = await this.signedValidRoles(ctx, subject, null);
    return hasRequiredRoleQuorum(requiredRoles, new Set(roles));
  }

  /**
   * Convenience for the §6 gate (check 11). Returns the roles whose signature is
   * currently valid. When `activePolicyVersion` is supplied, signatures made
   * against a superseded version are first marked stale (P0.4) and excluded.
   */
  public async signedValidRoles(
    ctx: ServiceCallContext,
    subject: { type: "payment_intent" | "proposal"; id: string },
    activePolicyVersion: number | null,
  ): Promise<string[]> {
    return withTenantScope(this.deps.pool, ctx.tenantId, async (c) => {
      if (activePolicyVersion !== null) {
        await markStaleForSupersededVersion(
          c,
          subject.type as ApprovalSubjectType,
          subject.id,
          activePolicyVersion,
        );
      }
      const rows = await listValidApprovals(
        c,
        subject.type as ApprovalSubjectType,
        subject.id,
        activePolicyVersion,
      );
      return rows.map((r) => r.approver_role).filter((r): r is string => r !== null);
    });
  }

  /** Back-compat shim: valid roles ignoring policy version. */
  public async signedRoles(
    ctx: ServiceCallContext,
    subject: { type: "payment_intent" | "proposal"; id: string },
  ): Promise<string[]> {
    return this.signedValidRoles(ctx, subject, null);
  }
}

function hasRequiredRoleQuorum(
  requiredRoles: readonly string[],
  signedRoles: ReadonlySet<string>,
): boolean {
  const available = new Set(signedRoles);
  let signerSlots = 0;
  for (const requiredRole of requiredRoles) {
    if (requiredRole === "signer") {
      signerSlots += 1;
      continue;
    }
    if (!available.delete(requiredRole)) return false;
  }
  return available.size >= signerSlots;
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
