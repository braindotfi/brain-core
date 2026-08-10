import { describe, expect, it } from "vitest";
import {
  PROPOSAL_TYPES,
  decisionsForProposal,
  resolvePublicProposalType,
  type ProposalType,
} from "./read-model.js";

describe("proposal read model type resolver", () => {
  it("maps every public proposal type directly", () => {
    for (const type of PROPOSAL_TYPES) {
      expect(resolvePublicProposalType({ actionType: type })).toBe(type);
    }
  });

  it("maps stored action types that are not public types", () => {
    const cases: Array<{ actionType: string; expected: ProposalType }> = [
      { actionType: "flag_transaction", expected: "fraud_anomaly" },
      { actionType: "block_payment", expected: "vendor_risk" },
      { actionType: "propose_match", expected: "reconciliation" },
      { actionType: "recommend_card", expected: "travel_finance" },
      { actionType: "recommend_savings_transfer", expected: "savings" },
      { actionType: "tag_tax_item", expected: "tax_prep" },
      { actionType: "remind", expected: "bill_management" },
    ];

    for (const row of cases) {
      expect(resolvePublicProposalType({ actionType: row.actionType })).toBe(row.expected);
    }
  });

  it("uses agent role to resolve ambiguous action names", () => {
    expect(resolvePublicProposalType({ actionType: "notify", joinedAgentRole: "compliance" })).toBe(
      "compliance",
    );
    expect(
      resolvePublicProposalType({ actionType: "notify", joinedAgentRole: "personal_budget" }),
    ).toBe("personal_budget");
    expect(
      resolvePublicProposalType({ actionType: "create_task", joinedAgentRole: "collections" }),
    ).toBe("collections");
    expect(resolvePublicProposalType({ actionType: "escalate", joinedAgentRole: "dispute" })).toBe(
      "dispute",
    );
  });

  it("keeps money-moving payment intent rows domain-specific when agent role is known", () => {
    expect(
      resolvePublicProposalType({
        actionType: "ach_outbound",
        joinedAgentRole: "bill_management",
      }),
    ).toBe("bill_management");
    expect(
      resolvePublicProposalType({
        actionType: "onchain_transfer",
        joinedAgentRole: "treasury",
      }),
    ).toBe("treasury");
    expect(resolvePublicProposalType({ actionType: "ach_outbound" })).toBeNull();
  });
});

describe("proposal read model decisions", () => {
  it("does not expose a decision for a superseded proposal", () => {
    expect(decisionsForProposal("collections", "propose", "superseded")).toEqual([]);
  });
});
