import { describe, expect, it } from "vitest";
import type { EvidenceBundle } from "./evidence.js";
import { billManagementHandler } from "./bill_management/handler.js";
import { vendorRiskHandler } from "./vendor_risk/handler.js";

const EMPTY_EVIDENCE: EvidenceBundle = {
  items: [],
  completeness: 1,
  evidence_score: 1,
  missing_required_evidence: [],
  critical_missing: false,
};

function withItems(refs: readonly { kind: string; ref: string }[]): EvidenceBundle {
  return { ...EMPTY_EVIDENCE, items: refs };
}

describe("billManagementHandler financial branch", () => {
  it("builds a payment_intent for propose_payment with full context", () => {
    const proposed = billManagementHandler.build({
      action: "propose_payment",
      context: {
        source_account_id: "acct_1",
        destination_counterparty_id: "cp_2",
        amount: "1200",
        currency: "EUR",
        invoice_id: "inv_9",
      },
      evidence: withItems([
        { kind: "invoice", ref: "inv_ref" },
        { kind: "balance", ref: "bal_ref" },
      ]),
    });
    expect(proposed.channel).toBe("payment_intent");
    if (proposed.channel === "payment_intent") {
      expect(proposed.intent).toMatchObject({
        action_type: "ach_outbound",
        source_account_id: "acct_1",
        destination_counterparty_id: "cp_2",
        amount: "1200",
        currency: "EUR",
        invoice_id: "inv_9",
      });
      expect(proposed.intent.evidence_ids).toEqual(["inv_ref", "bal_ref"]);
    }
  });

  it("applies amount/currency defaults and omits invoice_id when absent", () => {
    const proposed = billManagementHandler.build({
      action: "schedule_payment",
      context: { source_account_id: "acct_2" },
      evidence: EMPTY_EVIDENCE,
    });
    expect(proposed.channel).toBe("payment_intent");
    if (proposed.channel === "payment_intent") {
      expect(proposed.intent.amount).toBe("0");
      expect(proposed.intent.currency).toBe("USD");
      expect(proposed.intent).not.toHaveProperty("invoice_id");
      expect(proposed.intent.evidence_ids).toEqual([]);
    }
  });

  it("falls back to an agent proposal for advisory (non-financial) actions", () => {
    const proposed = billManagementHandler.build({
      action: "remind",
      context: {},
      evidence: EMPTY_EVIDENCE,
    });
    expect(proposed.channel).toBe("agent");
    if (proposed.channel === "agent") {
      expect(proposed.action.type).toBe("remind");
    }
  });
});

describe("vendorRiskHandler branches", () => {
  it("escalates block_payment to block_payment when risk evidence is present", () => {
    const proposed = vendorRiskHandler.build({
      action: "block_payment",
      context: { counterparty_id: "cp_1", payment_destination: "dest_1" },
      evidence: withItems([{ kind: "counterparty_history", ref: "hist_1" }]),
    });
    expect(proposed.channel).toBe("agent");
    if (proposed.channel === "agent") {
      expect(proposed.action.type).toBe("block_payment");
      expect(proposed.action.counterparty_id).toBe("cp_1");
      expect(proposed.action.payment_destination).toBe("dest_1");
      expect(proposed.action.evidence_refs).toEqual([
        { kind: "counterparty_history", ref: "hist_1" },
      ]);
    }
  });

  it("keeps a non-flag action unchanged even with risk evidence", () => {
    const proposed = vendorRiskHandler.build({
      action: "escalate",
      context: { counterparty_id: "cp_2", verified_status: "document_verified" },
      evidence: withItems([{ kind: "counterparty_history", ref: "hist_2" }]),
    });
    expect(proposed.channel).toBe("agent");
    if (proposed.channel === "agent") {
      expect(proposed.action.type).toBe("escalate");
    }
  });

  it("holds when counterparty identity is unresolved", () => {
    const proposed = vendorRiskHandler.build({
      action: "require_approval",
      context: {},
      evidence: EMPTY_EVIDENCE,
    });
    expect(proposed.channel).toBe("agent");
    if (proposed.channel === "agent") {
      expect(proposed.action.type).toBe("block_payment");
      expect(proposed.action.counterparty_id).toBeNull();
      expect(proposed.action.payment_destination).toBeNull();
      expect(proposed.action.recommended_action).toBe("hold");
      expect(proposed.action.evidence_refs).toEqual([]);
    }
  });
});
