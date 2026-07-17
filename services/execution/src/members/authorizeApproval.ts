import type { ActorContext, ApprovalDomain, MemberAuthority, MemberRole } from "./types.js";

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
  payeeKind: "vendor" | "employee";
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
  if (!isApprovalCapableRole(member.role)) {
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

  const normalizedPayeeEmail = normalizeApprovalEmail(proposal.payeeEmail);
  const normalizedMemberEmail = normalizeApprovalEmail(member.email);
  // Employee payees fail closed when the email join is absent. Vendor payees
  // without an email still pass in v1 because canonical vendor identity links
  // are not yet first-class in Ledger.
  if (normalizedPayeeEmail === null && proposal.payeeKind === "employee") {
    return reject("self_approval_blocked", {
      member_id: member.id,
      payee_unresolved: true,
    });
  }
  if (normalizedPayeeEmail !== null && normalizedPayeeEmail === normalizedMemberEmail) {
    return reject("self_approval_blocked", {
      member_id: member.id,
      payee_email: proposal.payeeEmail,
    });
  }

  // Per-member dual-control threshold. If this member requires a second approver
  // above X cents and the amount exceeds it, force at least two distinct
  // approvals even when policy asked for one. (This member field was stored and
  // API-settable but never enforced before.)
  let requiredDistinctApprovals = Math.max(1, input.requiredDistinctApprovals);
  if (
    member.requiresSecondApproverAboveCents !== null &&
    proposal.amountCents > member.requiresSecondApproverAboveCents
  ) {
    requiredDistinctApprovals = Math.max(requiredDistinctApprovals, 2);
  }
  const existing = new Set(input.existingApproverMemberIds);
  if (requiredDistinctApprovals > 1 && existing.has(member.id)) {
    return reject("second_approval_required", {
      member_id: member.id,
      required_distinct_approvals: requiredDistinctApprovals,
    });
  }
  const requiresAdditionalApproval =
    requiredDistinctApprovals > 1 && existing.size + 1 < requiredDistinctApprovals;

  return { allowed: true, requiresAdditionalApproval, approverRole: member.role };
}

export function isApprovalCapableRole(role: MemberRole): role is "admin" | "approver" {
  return role === "admin" || role === "approver";
}

export function paymentIntentApprovalDomain(
  actionType: string,
  payeeKind?: ApprovalDomainSource["payeeKind"],
): ApprovalDomain {
  // Payroll disbursements (employee payee) must authorize against the payroll
  // domain, not fall through to `ap`. Before this an AP-only approver could
  // approve a payroll run because it was classified as `ap`.
  if (payeeKind === "employee" || actionType.includes("payroll")) {
    return "payroll";
  }
  switch (actionType) {
    case "ach_inbound":
      return "ar";
    case "erp_writeback":
      return "reconciliation";
    default:
      // ponytail: no PaymentIntent action_type maps to `treasury` yet (treasury
      // is an agent_key, not a PI action), so treasury moves classify as `ap`.
      // Upgrade: add a treasury action_type and map it here when one exists.
      return "ap";
  }
}

export function paymentIntentPayeeKind(input: {
  actionType: string;
  counterpartyType?: string | null;
}): ApprovalDomainSource["payeeKind"] {
  if (input.counterpartyType === "employee" || input.actionType.includes("payroll")) {
    return "employee";
  }
  return "vendor";
}

// Larger than any BIGINT per_item_limit_cents (max int64), so an unparseable
// amount fails the limit check closed instead of silently passing as zero.
const UNPARSEABLE_AMOUNT_CENTS = 9_223_372_036_854_775_808n;

export function decimalAmountToCents(value: string): bigint {
  const trimmed = value.trim();
  // Accept ANY fractional precision. The prior `([0-9]{1,2})` bound made a
  // 3+-decimal amount (routine for on-chain / USDC) fall through to 0n, which
  // then passed every per-item limit check (0n > limit is false).
  const match = /^([0-9]+)(?:\.([0-9]+))?$/.exec(trimmed);
  if (match === null) return UNPARSEABLE_AMOUNT_CENTS;
  const whole = BigInt(match[1] ?? "0") * 100n;
  const fractionDigits = match[2] ?? "";
  const cents = BigInt(fractionDigits.slice(0, 2).padEnd(2, "0"));
  // Any non-zero digit beyond cents rounds the amount UP one cent, so a
  // sub-cent tail can never understate the value against a per-item limit.
  const roundUp = /[1-9]/.test(fractionDigits.slice(2)) ? 1n : 0n;
  return whole + cents + roundUp;
}

function reject(
  reason: ApprovalRejectionReason,
  detail: Record<string, unknown>,
): ApprovalAuthorization {
  return { allowed: false, reason, detail: { reason, ...detail } };
}

function normalizeApprovalEmail(email: string | null): string | null {
  if (email === null) return null;
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.indexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return null;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  const plus = local.indexOf("+");
  return `${plus >= 0 ? local.slice(0, plus) : local}@${domain}`;
}
