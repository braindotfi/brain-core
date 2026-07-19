import { describe, expect, it } from "vitest";
import { isBrainError } from "@brain/shared";
import type { EvidenceBundle } from "../evidence.js";
import { reconciliationDefinition } from "./definition.js";
import { reconciliationHandler } from "./handler.js";

const EVIDENCE: EvidenceBundle = {
  items: [{ kind: "transaction", ref: "tx_1", confidence: 0.9 }],
  completeness: 1,
  evidence_score: 0.9,
  missing_required_evidence: [],
  critical_missing: false,
};

describe("reconciliationHandler", () => {
  it("proposes the best grounded match above the confidence floor", () => {
    const proposed = reconciliationHandler.build({
      action: "propose_match",
      context: {
        transaction_id: "tx_1",
        amount: "900.00",
        currency: "USD",
        direction: "inflow",
        transaction_date: "2026-07-18T00:00:00.000Z",
        counterparty_id: "cp_1",
        counterparty_name: "Acme",
        candidates: [
          {
            kind: "invoice",
            id: "inv_1",
            amount: "900.00",
            currency: "USD",
            date: "2026-07-18T00:00:00.000Z",
            counterparty_id: "cp_1",
            counterparty_name: "Acme",
            label: "INV-1",
          },
          {
            kind: "invoice",
            id: "inv_2",
            amount: "899.99",
            currency: "USD",
            date: "2026-07-18T00:00:00.000Z",
            counterparty_id: "cp_1",
          },
        ],
      },
      evidence: EVIDENCE,
      definition: reconciliationDefinition,
      confidence: 0.95,
      now: new Date("2026-07-18T00:00:00.000Z"),
    });

    expect(proposed.channel).toBe("agent");
    if (proposed.channel === "agent") {
      expect(proposed.action).toMatchObject({
        type: "reconciliation",
        recommended_action: "propose_match",
        match_type: "propose_match",
        left_entity_type: "transaction",
        left_entity_id: "tx_1",
        right_entity_type: "invoice",
        right_entity_id: "inv_1",
        confidence_score: 1,
        match_basis: ["amount_equal", "counterparty_match", "date_within_1_day"],
        confidence: 0.9,
        evidence_refs: [{ kind: "transaction", ref: "tx_1" }],
        mode: "propose",
      });
      expect(String(proposed.action.narrative)).toContain("proposed invoice match inv_1");
    }
  });

  it("flags no_match when the only same-amount candidate has the wrong counterparty", () => {
    const proposed = reconciliationHandler.build({
      action: "propose_match",
      context: {
        transaction_id: "tx_1",
        amount: "900.00",
        currency: "USD",
        direction: "inflow",
        transaction_date: "2026-07-18T00:00:00.000Z",
        counterparty_id: "cp_1",
        candidates: [
          {
            kind: "invoice",
            id: "inv_wrong",
            amount: "900.00",
            currency: "USD",
            date: "2026-07-18T00:00:00.000Z",
            counterparty_id: "cp_2",
          },
        ],
      },
      evidence: EVIDENCE,
      definition: reconciliationDefinition,
    });

    expect(proposed.channel).toBe("agent");
    if (proposed.channel === "agent") {
      expect(proposed.action).toMatchObject({
        recommended_action: "no_match",
        match_type: "no_match",
        right_entity_id: null,
        confidence_score: 0.65,
      });
    }
  });

  it("fails closed when transaction context is incomplete", () => {
    expect(() =>
      reconciliationHandler.build({
        action: "propose_match",
        context: {
          transaction_id: "tx_1",
          currency: "USD",
          transaction_date: "2026-07-18T00:00:00.000Z",
        },
        evidence: EVIDENCE,
        definition: reconciliationDefinition,
      }),
    ).toThrow();

    try {
      reconciliationHandler.build({
        action: "propose_match",
        context: {
          transaction_id: "tx_1",
          currency: "USD",
          transaction_date: "2026-07-18T00:00:00.000Z",
        },
        evidence: EVIDENCE,
        definition: reconciliationDefinition,
      });
      throw new Error("expected build to fail");
    } catch (err) {
      expect(isBrainError(err)).toBe(true);
      expect((err as { code?: string }).code).toBe("request_body_invalid");
    }
  });
});
