import { describe, expect, it } from "vitest";
import { isBrainError } from "@brain/shared";
import type { EvidenceBundle } from "../evidence.js";
import { collectionsDefinition } from "./definition.js";
import { collectionsHandler, refreshCollectionsActionDaysOverdue } from "./handler.js";

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
      expect(proposed.action.ranked_recommendations).toEqual([
        "create_task",
        "draft_followup",
        "escalate",
        "propose_payment_plan",
      ]);
      expect(String(proposed.action.narrative)).toContain("Acme");
      expect(String(proposed.action.narrative)).toContain("1200.50 USD");
      expect(String(proposed.action.narrative)).toContain("18 days overdue");
      expect(String(proposed.action.draft_message)).toContain("INV-1");
    }
  });

  it("keeps requested-action overrides first in ranked recommendations", () => {
    const proposed = collectionsHandler.build({
      action: "escalate",
      context: {
        invoice_id: "inv_2",
        counterparty_id: "cp_1",
        amount: "1200.50",
        currency: "USD",
        due_date: "2026-07-01T00:00:00.000Z",
        days_overdue: 10,
        counterparty_name: "Acme",
      },
      evidence: EVIDENCE,
      definition: collectionsDefinition,
      now: new Date("2026-07-18T00:00:00.000Z"),
    });

    expect(proposed.channel).toBe("agent");
    if (proposed.channel === "agent") {
      expect(proposed.action).toMatchObject({
        recommended_action: "escalate",
        ranked_recommendations: [
          "escalate",
          "draft_followup",
          "create_task",
          "propose_payment_plan",
        ],
      });
      expect(proposed.action.narrative).toBe(
        "Acme has 1200.50 USD outstanding on invoice INV-2, 10 days overdue. " +
          "Recommend escalation with urgent tone at the escalation tier.",
      );
      expect(proposed.action.narrative).not.toContain("escalation escalation");
    }
  });

  it("refreshCollectionsActionDaysOverdue moves recommendation, tone, escalation tier, and risk band together on a tier crossing", () => {
    const proposed = collectionsHandler.build({
      action: "draft_followup",
      context: {
        invoice_id: "inv_3",
        counterparty_id: "cp_1",
        amount: "500.00",
        currency: "USD",
        due_date: "2026-06-01T00:00:00.000Z",
        days_overdue: 45,
        counterparty_name: "Acme",
      },
      evidence: EVIDENCE,
      definition: collectionsDefinition,
      confidence: 0.9,
      now: new Date("2026-07-16T00:00:00.000Z"),
    });
    if (proposed.channel !== "agent") throw new Error("expected agent channel");
    expect(proposed.action).toMatchObject({
      days_overdue: 45,
      aging_tier: "30_59",
      recommended_action: "escalate",
      escalation_tier: "escalation",
      recommended_tone: "urgent",
      risk_band: "high",
    });

    const refreshed = refreshCollectionsActionDaysOverdue(proposed.action, {
      daysOverdue: 62,
      now: new Date("2026-08-02T00:00:00.000Z"),
    });

    expect(refreshed).toMatchObject({
      days_overdue: 62,
      aging_tier: "60_89",
      recommended_action: "propose_payment_plan",
      escalation_tier: "payment_plan",
      recommended_tone: "collaborative",
      risk_band: "high",
    });
    expect(String(refreshed.narrative)).toContain("62 days overdue");
    expect(String(refreshed.summary)).toContain("62 days overdue");

    // Evidence-derived and identity fields stay untouched.
    expect(refreshed.confidence).toBe(proposed.action.confidence);
    expect(refreshed.evidence_score).toBe(proposed.action.evidence_score);
    expect(refreshed.evidence_refs).toEqual(proposed.action.evidence_refs);
    expect(refreshed.missing_required_evidence).toEqual(proposed.action.missing_required_evidence);
    expect(refreshed.critical_missing).toBe(proposed.action.critical_missing);
    expect(refreshed.invoice_id).toBe("inv_3");
    expect(refreshed.counterparty_id).toBe("cp_1");
    expect(refreshed.amount_due).toBe("500.00");
    expect(refreshed.currency).toBe("USD");
    expect(refreshed.due_date).toBe("2026-06-01T00:00:00.000Z");
    expect(refreshed.mode).toBe(proposed.action.mode);
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
