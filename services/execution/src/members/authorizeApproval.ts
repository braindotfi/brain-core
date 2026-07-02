import type { ActorContext, ApprovalDomain, MemberAuthority } from "./types.js";

export type ApprovalRejectionReason =
  | "actor_unresolved"
  | "actor_inactive"
  | "domain_not_authorized"
  | "actor_limit_exceeded"
  | "second_approval_required"
  | "self_approval_blocked"
  | "last_admin_protected";

export type ApprovalDomainSource = {
  domain: ApprovalDomain;
  amountCents: bigint;
  payeeEmail: string | null;
};

export interface AuthorizeApprovalInput {
  actor: ActorContext;
  member: MemberAuthority | null;
  proposal: ApprovalDomainSource;
  existingApproverMemberIds: readonly string[];
  requiredDistinctApprovals: number;
}

export type ApprovalAuthorization =
  | {
      allowed: true;
      requiresAdditionalApproval: boolean;
      approverRole: "admin" | "approver";
    }
  | {
      allowed: false;
      reason: ApprovalRejectionReason;
      detail: Record<string, unknown>;
    };

export function authorizeApproval(input: AuthorizeApprovalInput): ApprovalAuthorization {
  const { actor, member, proposal } = input;

  if (member === null) {
    return reject("actor_unresolved", { member_id: actor.memberId });
  }
  if (!member.active) {
    return reject("actor_inactive", { member_id: member.id });
  }
  if (member.role !== "admin" && member.role !== "approver") {
    return reject("domain_not_authorized", { member_id: member.id, role: member.role });
  }
  if (!member.approvalDomains.includes(proposal.domain)) {
    return reject("domain_not_authorized", {
      member_id: member.id,
      domain: proposal.domain,
      allowed_domains: member.approvalDomains,
    });
  }
  if (proposal.amountCents > member.perItemLimitCents) {
    return reject("actor_limit_exceeded", {
      member_id: member.id,
      amount_cents: proposal.amountCents.toString(),
      limit_cents: member.perItemLimitCents.toString(),
    });
  }

  const requiredDistinctApprovals = Math.max(1, input.requiredDistinctApprovals);
  const existing = new Set(input.existingApproverMemberIds);
  if (requiredDistinctApprovals > 1 && existing.has(member.id)) {
    return reject("second_approval_required", {
      member_id: member.id,
      required_distinct_approvals: requiredDistinctApprovals,
    });
  }
  const requiresAdditionalApproval =
    requiredDistinctApprovals > 1 && existing.size + 1 < requiredDistinctApprovals;

  if (
    proposal.payeeEmail !== null &&
    proposal.payeeEmail.toLowerCase() === member.email.toLowerCase()
  ) {
    return reject("self_approval_blocked", {
      member_id: member.id,
      payee_email: proposal.payeeEmail,
    });
  }

  return { allowed: true, requiresAdditionalApproval, approverRole: member.role };
}

export function paymentIntentApprovalDomain(actionType: string): ApprovalDomain {
  switch (actionType) {
    case "ach_inbound":
      return "ar";
    case "erp_writeback":
      return "reconciliation";
    default:
      return "ap";
  }
}

export function decimalAmountToCents(value: string): bigint {
  const trimmed = value.trim();
  const match = /^([0-9]+)(?:\.([0-9]{1,2}))?$/.exec(trimmed);
  if (match === null) return 0n;
  const whole = BigInt(match[1] ?? "0") * 100n;
  const fraction = (match[2] ?? "").padEnd(2, "0");
  return whole + BigInt(fraction === "" ? "0" : fraction);
}

function reject(
  reason: ApprovalRejectionReason,
  detail: Record<string, unknown>,
): ApprovalAuthorization {
  return { allowed: false, reason, detail: { reason, ...detail } };
}
