/**
 * IApprovalService — supports the §6 gate and the PaymentIntent / Proposal
 * approval flow.
 *
 * Concrete implementation lands in services/agent/ (Phase 4). The interface
 * lives here so any caller can write against the contract without taking a
 * runtime dependency on @brain/agent.
 */

import type { ServiceCallContext } from "./types.js";

export type ApprovalSubjectType = "payment_intent" | "proposal";

export interface ApprovalRecord {
  id: string;
  subject_type: ApprovalSubjectType;
  subject_id: string;
  approver_principal_id: string;
  approver_role: string | null;
  signed_at: string;
  signature: string | null; // EIP-712 signature for high-value payment intents
}

export interface IApprovalService {
  sign(
    ctx: ServiceCallContext,
    subject: { type: ApprovalSubjectType; id: string },
    role?: string,
    signature?: string,
  ): Promise<ApprovalRecord>;

  signAndCheckRequiredApprovals(
    ctx: ServiceCallContext,
    subject: { type: ApprovalSubjectType; id: string },
    requiredRoles: readonly string[],
    role?: string,
    signature?: string,
  ): Promise<{ approval: ApprovalRecord; quorumMet: boolean }>;

  list(
    ctx: ServiceCallContext,
    subject: { type: ApprovalSubjectType; id: string },
  ): Promise<ApprovalRecord[]>;

  /**
   * True iff every required approver in `requiredRoles` has at least one
   * signed approval record for the subject. Used by the §6 gate
   * (check #11 — "approval has been granted when required").
   */
  hasRequiredApprovals(
    ctx: ServiceCallContext,
    subject: { type: ApprovalSubjectType; id: string },
    requiredRoles: string[],
  ): Promise<boolean>;
}
