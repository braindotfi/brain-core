import { describe, expect, it } from "vitest";
import { invoiceIntegrityDefinition } from "./definition.js";
import { invoiceIntegrityHandler } from "./handler.js";
import type { EvidenceBundle } from "../evidence.js";
import type { HandlerInput, ProposedAction } from "../handler.js";

const evidence: EvidenceBundle = {
  items: [{ kind: "obligation", ref: "obl_1", confidence: 1 }],
  completeness: 1,
  evidence_score: 1,
  missing_required_evidence: [],
  critical_missing: false,
};

describe("invoiceIntegrityHandler", () => {
  it("flags a duplicate obligation", () => {
    const proposed = invoiceIntegrityHandler.build(
      input("flag_duplicate_invoice", {
        obligation_id: "obl_inv_cmp_002",
        amount: "48750.00",
        related_obligation_ids: ["obl_inv_cmp_001"],
      }),
    );

    expect(proposed.channel).toBe("agent");
    expect(agentAction(proposed)).toMatchObject({
      type: "flag_duplicate_invoice",
      obligation_id: "obl_inv_cmp_002",
      finding_type: "duplicate",
      amount: "48750.00",
      currency: "USD",
      mode: "notify_only",
      evidence_refs: [{ kind: "obligation", ref: "obl_1" }],
    });
    expect(agentAction(proposed).narrative).toContain("obl_inv_cmp_001");
  });

  it("flags a structuring pattern", () => {
    const proposed = invoiceIntegrityHandler.build(
      input("flag_structuring", {
        obligation_id: "obl_inv_cmp_004",
        amount: "4875.00",
        related_obligation_ids: ["obl_inv_cmp_005", "obl_inv_cmp_006"],
        group_total_amount: "14725.00",
      }),
    );

    expect(agentAction(proposed)).toMatchObject({
      type: "flag_structuring",
      finding_type: "structuring",
      related_obligation_ids: ["obl_inv_cmp_005", "obl_inv_cmp_006"],
    });
    expect(agentAction(proposed).narrative).toContain("14725.00");
  });

  it("flags threshold avoidance", () => {
    const proposed = invoiceIntegrityHandler.build(
      input("flag_threshold_avoidance", {
        obligation_id: "obl_inv_cmp_010",
        amount: "89999.00",
        threshold_amount: "90000.00",
      }),
    );

    expect(agentAction(proposed)).toMatchObject({
      type: "flag_threshold_avoidance",
      finding_type: "threshold_avoidance",
    });
    expect(agentAction(proposed).narrative).toContain("90000.00");
  });

  it("flags a high-value obligation to an unverified new vendor", () => {
    const proposed = invoiceIntegrityHandler.build(
      input("flag_unverified_vendor", {
        obligation_id: "obl_inv_cmp_003",
        amount: "275000.00",
        counterparty_verified_status: "unverified",
      }),
    );

    expect(agentAction(proposed)).toMatchObject({
      type: "flag_unverified_vendor",
      finding_type: "new_vendor",
    });
    expect(agentAction(proposed).narrative).toContain("unverified");
  });

  it("rejects a missing obligation id", () => {
    expect(() =>
      invoiceIntegrityHandler.build(
        input("flag_duplicate_invoice", { obligation_id: "", amount: "10.00" }),
      ),
    ).toThrow("obligation_id is required");
  });

  it("rejects an unsupported action", () => {
    expect(() => invoiceIntegrityHandler.build(input("freeze_card", { amount: "10.00" }))).toThrow(
      "unsupported invoice_integrity action: freeze_card",
    );
  });
});

function input(action: string, context: Record<string, unknown>): HandlerInput {
  return {
    action,
    context: {
      obligation_id: "obl_1",
      amount: "100.00",
      currency: "USD",
      due_date: "2026-08-15",
      counterparty_id: "cp_1",
      counterparty_name: "Eval Vendor",
      ...context,
    },
    evidence,
    definition: invoiceIntegrityDefinition,
    confidence: 1,
    now: new Date("2026-08-16T00:00:00.000Z"),
  };
}

function agentAction(proposed: ProposedAction): Record<string, unknown> {
  if (proposed.channel !== "agent") {
    throw new Error("expected agent proposal");
  }
  return proposed.action;
}
