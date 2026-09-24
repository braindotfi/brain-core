import { describe, expect, it } from "vitest";
import type { EvidenceBundle } from "../evidence.js";
import { amlComplianceDefinition } from "./definition.js";
import { amlComplianceHandler } from "./handler.js";

const evidence: EvidenceBundle = {
  items: [{ kind: "payment_intent", ref: "pi_1" }],
  completeness: 1,
  evidence_score: 1,
  missing_required_evidence: [],
  critical_missing: false,
};

describe("amlComplianceHandler", () => {
  it("builds provide docs proposals", () => {
    const proposed = amlComplianceHandler.build({
      action: "provide_docs",
      context: context(),
      evidence,
      definition: amlComplianceDefinition,
      now: new Date("2026-09-20T00:00:00.000Z"),
    });

    expect(proposed.channel).toBe("agent");
    if (proposed.channel === "agent") {
      expect(proposed.action).toMatchObject({
        type: "aml_compliance",
        recommended_action: "provide_docs",
        decision_effect: { kind: "mark_documents_attached" },
      });
    }
  });

  it("builds delegate proposals", () => {
    const proposed = amlComplianceHandler.build({
      action: "delegate",
      context: { ...context(), delegate_to_user_id: "usr_1" },
      evidence,
      definition: amlComplianceDefinition,
    });

    expect(proposed.channel).toBe("agent");
    if (proposed.channel === "agent") {
      expect(proposed.action).toMatchObject({
        recommended_action: "delegate",
        decision_effect: { kind: "emit_delegation_event", target_user_id: "usr_1" },
      });
    }
  });

  it("builds hold proposals", () => {
    const proposed = amlComplianceHandler.build({
      action: "hold",
      context: context(),
      evidence,
      definition: amlComplianceDefinition,
    });

    expect(proposed.channel).toBe("agent");
    if (proposed.channel === "agent") {
      expect(proposed.action).toMatchObject({
        recommended_action: "hold",
        decision_effect: { kind: "pause_payment_intent", renotify_after: "P1D" },
      });
    }
  });
});

function context(): Record<string, unknown> {
  return {
    payment_id: "pi_1",
    beneficiary_id: "cp_1",
    amount: "12000.00",
    currency: "USD",
    jurisdictions_involved: ["US"],
    screenings: {
      ofac: { status: "clear", lists_checked: ["stub.ofac"], timestamp: "2026-09-20T00:00:00Z" },
      pep: { status: "clear", matches: [] },
      kyc_freshness: { status: "stale", note: "kyc_store_not_wired" },
    },
    required_documents: [{ type: "beneficiary_kyc", status: "needed", description: "KYC" }],
    regulatory_context: {
      jurisdiction: "US",
      regulation_id: "US-BSA-CTR-10000",
      threshold: "10000.00",
      purpose_code_required: false,
    },
    deadline: "2026-09-21T00:00:00.000Z",
  };
}
