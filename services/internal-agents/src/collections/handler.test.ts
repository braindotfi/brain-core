import { describe, expect, it } from "vitest";
import { isBrainError } from "@brain/shared";
import type { EvidenceBundle } from "../evidence.js";
import { collectionsDefinition } from "./definition.js";
import { collectionsHandler } from "./handler.js";

const EVIDENCE: EvidenceBundle = {
  items: [
    { kind: "invoice", ref: "inv_1", confidence: 0.9 },
    { kind: "counterparty", ref: "cp_1", confidence: 0.8 },
  ],
  completeness: 1,
  evidence_score: 0.8,
  missing_required_evidence: [],
  critical_missing: false,
};

describe("collectionsHandler", () => {
  it("builds a grounded overdue receivable recommendation", () => {
    const proposed = collectionsHandler.build({
      action: "draft_followup",
      context: {
        invoice_id: "inv_1",
        counterparty_id: "cp_1",
        amount: "1200.50",
        currency: "USD",
        due_date: "2026-07-01T00:00:00.000Z",
        days_overdue: 18,
        aging_tier: "15_29",
        counterparty_name: "Acme",
      },
      evidence: EVIDENCE,
      definition: collectionsDefinition,
      confidence: 0.95,
      now: new Date("2026-07-18T00:00:00.000Z"),
    });

    expect(proposed.channel).toBe("agent");
    if (proposed.channel === "agent") {
      expect(proposed.action).toMatchObject({
        type: "collections",
        recommended_action: "create_task",
        escalation_tier: "task",
        risk_band: "elevated",
        amount_due: "1200.50",
        currency: "USD",
        days_overdue: 18,
        aging_tier: "15_29",
        recommended_tone: "firm",
        next_escalation_date: "2026-07-23",
        confidence: 0.8,
        evidence_score: 0.8,
        evidence_refs: [
          { kind: "invoice", ref: "inv_1" },
          { kind: "counterparty", ref: "cp_1" },
        ],
      });
      expect(String(proposed.action.narrative)).toContain("Acme");
      expect(String(proposed.action.narrative)).toContain("1200.50 USD");
      expect(String(proposed.action.narrative)).toContain("18 days overdue");
      expect(String(proposed.action.draft_message)).toContain("INV-1");
    }
  });

  it("fails closed when receivable context is incomplete", () => {
    try {
      collectionsHandler.build({
        action: "draft_followup",
        context: {
          invoice_id: "inv_1",
          amount: "1200.50",
          currency: "USD",
          due_date: "2026-07-01T00:00:00.000Z",
          days_overdue: 18,
        },
        evidence: EVIDENCE,
        definition: collectionsDefinition,
      });
      throw new Error("expected build to fail");
    } catch (err) {
      expect(isBrainError(err)).toBe(true);
      expect((err as { code?: string }).code).toBe("request_body_invalid");
    }
  });
});
