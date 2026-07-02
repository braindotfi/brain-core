import { describe, expect, it } from "vitest";
import type { ActorContext, MemberAuthority } from "./types.js";
import { authorizeApproval, decimalAmountToCents } from "./authorizeApproval.js";

const actor: ActorContext = {
  memberId: "usr_1",
  email: "approver@example.com",
  verification: "session",
};

function member(overrides: Partial<MemberAuthority> = {}): MemberAuthority {
  return {
    id: "usr_1",
    tenantId: "tnt_1",
    email: "approver@example.com",
    displayName: "Approver",
    role: "approver",
    active: true,
    approvalDomains: ["ap"],
    perItemLimitCents: 1_000_00n,
    requiresSecondApproverAboveCents: null,
    ...overrides,
  };
}

function input(overrides: Partial<Parameters<typeof authorizeApproval>[0]> = {}) {
  return {
    actor,
    member: member(),
    proposal: {
      domain: "ap" as const,
      amountCents: 100_00n,
      payeeKind: "vendor" as const,
      payeeEmail: null,
    },
    existingApproverMemberIds: [],
    requiredDistinctApprovals: 1,
    ...overrides,
  };
}

describe("authorizeApproval", () => {
  it("rejects unresolved actors first", () => {
    expect(authorizeApproval(input({ member: null }))).toMatchObject({
      allowed: false,
      reason: "actor_unresolved",
    });
  });

  it("rejects inactive members", () => {
    expect(authorizeApproval(input({ member: member({ active: false }) }))).toMatchObject({
      allowed: false,
      reason: "actor_inactive",
    });
  });

  it("rejects viewers as not authorized", () => {
    expect(authorizeApproval(input({ member: member({ role: "viewer" }) }))).toMatchObject({
      allowed: false,
      reason: "domain_not_authorized",
    });
  });

  it("rejects missing approval domain", () => {
    expect(
      authorizeApproval(input({ member: member({ approvalDomains: ["treasury"] }) })),
    ).toMatchObject({
      allowed: false,
      reason: "domain_not_authorized",
    });
  });

  it("rejects member limit breaches", () => {
    expect(
      authorizeApproval(input({ member: member({ perItemLimitCents: 99_99n }) })),
    ).toMatchObject({
      allowed: false,
      reason: "actor_limit_exceeded",
    });
  });

  it("marks a first approval as awaiting a distinct second member", () => {
    expect(authorizeApproval(input({ requiredDistinctApprovals: 2 }))).toEqual({
      allowed: true,
      requiresAdditionalApproval: true,
      approverRole: "approver",
    });
  });

  it("rejects same-member second approval attempts", () => {
    expect(
      authorizeApproval(
        input({ existingApproverMemberIds: ["usr_1"], requiredDistinctApprovals: 2 }),
      ),
    ).toMatchObject({
      allowed: false,
      reason: "second_approval_required",
    });
  });

  it("allows a distinct second member to complete approval", () => {
    expect(
      authorizeApproval(
        input({ existingApproverMemberIds: ["usr_2"], requiredDistinctApprovals: 2 }),
      ),
    ).toEqual({
      allowed: true,
      requiresAdditionalApproval: false,
      approverRole: "approver",
    });
  });

  it("rejects actor equals payee using email-match fallback", () => {
    expect(
      authorizeApproval(
        input({
          proposal: {
            domain: "ap",
            amountCents: 100_00n,
            payeeKind: "vendor",
            payeeEmail: "APPROVER@example.com",
          },
        }),
      ),
    ).toMatchObject({
      allowed: false,
      reason: "self_approval_blocked",
    });
  });

  it("rejects self-payee before second-approval reasoning", () => {
    expect(
      authorizeApproval(
        input({
          proposal: {
            domain: "ap",
            amountCents: 100_00n,
            payeeKind: "vendor",
            payeeEmail: "approver@example.com",
          },
          existingApproverMemberIds: ["usr_1"],
          requiredDistinctApprovals: 2,
        }),
      ),
    ).toMatchObject({
      allowed: false,
      reason: "self_approval_blocked",
    });
  });

  it("rejects employee payees with unresolved email", () => {
    expect(
      authorizeApproval(
        input({
          member: member({ approvalDomains: ["payroll"] }),
          proposal: {
            domain: "payroll",
            amountCents: 100_00n,
            payeeKind: "employee",
            payeeEmail: null,
          },
        }),
      ),
    ).toMatchObject({
      allowed: false,
      reason: "self_approval_blocked",
      detail: { payee_unresolved: true },
    });
  });

  it("blocks plus-addressed self-payee aliases", () => {
    expect(
      authorizeApproval(
        input({
          member: member({ email: "approver@example.com" }),
          proposal: {
            domain: "ap",
            amountCents: 100_00n,
            payeeKind: "vendor",
            payeeEmail: "approver+payroll@example.com",
          },
        }),
      ),
    ).toMatchObject({
      allowed: false,
      reason: "self_approval_blocked",
    });
  });

  it("blocks case-mismatched self-payee emails", () => {
    expect(
      authorizeApproval(
        input({
          member: member({ email: "Approver@Example.com" }),
          proposal: {
            domain: "ap",
            amountCents: 100_00n,
            payeeKind: "vendor",
            payeeEmail: " APPROVER@example.COM ",
          },
        }),
      ),
    ).toMatchObject({
      allowed: false,
      reason: "self_approval_blocked",
    });
  });

  it("parses decimal money strings into cents", () => {
    expect(decimalAmountToCents("12")).toBe(1_200n);
    expect(decimalAmountToCents("12.3")).toBe(1_230n);
    expect(decimalAmountToCents("12.34")).toBe(1_234n);
  });
});
