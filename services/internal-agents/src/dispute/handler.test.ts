import { describe, expect, it } from "vitest";
import type { EvidenceBundle } from "../evidence.js";
import type { ProposedAction } from "../handler.js";
import { disputeDefinition } from "./definition.js";
import { disputeHandler } from "./handler.js";

const evidence: EvidenceBundle = {
  items: [
    { kind: "dispute", ref: "dsp_1", confidence: 1 },
    { kind: "transaction", ref: "tx_1", confidence: 1 },
  ],
  completeness: 1,
  evidence_score: 1,
  missing_required_evidence: [],
  critical_missing: false,
};

describe("disputeHandler", () => {
  it("accepts small old disputes", () => {
    const action = agentAction(
      disputeHandler.build({
        action: "gather_evidence",
        context: baseContext({ amount: "50.00", dispute_age_days: 60, evidence_completeness: 1 }),
        evidence,
        definition: disputeDefinition,
      }),
    );
    expect(action).toMatchObject({ recommended_action: "accept", mode: "propose" });
  });

  it("contests large well-evidenced disputes", () => {
    const action = agentAction(
      disputeHandler.build({
        action: "create_dispute_packet",
        context: baseContext({ amount: "750.00", evidence_completeness: 1 }),
        evidence,
        definition: disputeDefinition,
      }),
    );
    expect(action).toMatchObject({
      recommended_action: "contest",
      risk_band: "elevated",
      dispute_id: "dsp_1",
      transaction_id: "tx_1",
    });
  });

  it("gathers evidence when evidence is incomplete or deadline is imminent", () => {
    const action = agentAction(
      disputeHandler.build({
        action: "gather_evidence",
        context: baseContext({
          amount: "750.00",
          evidence_completeness: 0.6,
          deadline: "2026-07-20T00:00:00.000Z",
        }),
        evidence,
        definition: disputeDefinition,
        now: new Date("2026-07-19T00:00:00.000Z"),
      }),
    );
    expect(action).toMatchObject({ recommended_action: "gather_evidence" });
  });

  it("fails closed when dispute evidence is missing", () => {
    expect(() =>
      disputeHandler.build({
        action: "gather_evidence",
        context: baseContext({}),
        evidence: {
          ...evidence,
          items: [{ kind: "transaction", ref: "tx_1" }],
          missing_required_evidence: ["dispute"],
          critical_missing: true,
        },
        definition: disputeDefinition,
      }),
    ).toThrow("dispute_required_evidence_missing");
  });
});

function baseContext(overrides: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return {
    dispute_id: "dsp_1",
    transaction_id: "tx_1",
    amount: "750.00",
    currency: "USD",
    deadline: "2026-08-01T00:00:00.000Z",
    dispute_age_days: 8,
    evidence_completeness: 1,
    ...overrides,
  };
}

function agentAction(proposed: ProposedAction): Record<string, unknown> {
  expect(proposed.channel).toBe("agent");
  if (proposed.channel !== "agent") throw new Error("expected agent proposal");
  return proposed.action;
}
