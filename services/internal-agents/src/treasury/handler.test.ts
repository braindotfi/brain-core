import { describe, expect, it } from "vitest";
import type { EvidenceBundle } from "../evidence.js";
import { treasuryHandler } from "./handler.js";

const EVIDENCE: EvidenceBundle = {
  items: [{ kind: "balance", ref: "bal_1" }],
  completeness: 1,
  evidence_score: 0.37,
  missing_required_evidence: [],
  critical_missing: false,
};

describe("treasuryHandler", () => {
  it("sets transfer confidence from the evidence score", () => {
    const proposed = treasuryHandler.build({
      action: "propose_transfer",
      context: {
        source_account_id: "acct_1",
        destination_counterparty_id: "cp_2",
        amount: "500",
        currency: "USD",
      },
      evidence: EVIDENCE,
    });

    expect(proposed.channel).toBe("payment_intent");
    if (proposed.channel !== "payment_intent") return;
    expect(proposed.intent.confidence).toBe(0.37);
  });
});
