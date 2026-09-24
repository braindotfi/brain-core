import { describe, expect, it } from "vitest";
import { internalAgentCatalog } from "./registry.js";
import { AGENT_PAYLOAD_REQUIRED_FIELDS, validateAgentPayload } from "./payloads.js";

const decisionContext = {
  decide_by: "Fri Sep 25, 4 days",
  if_wrong: "Acting early can be costly. Waiting can increase risk.",
  reversible: { state: "yes", label: "Yes before execution" },
};

describe("agent workflow payloads (2.1)", () => {
  it("every catalog agent has a payload contract", () => {
    for (const def of internalAgentCatalog) {
      expect(AGENT_PAYLOAD_REQUIRED_FIELDS[def.agent_key], def.agent_key).toBeDefined();
    }
    expect(Object.keys(AGENT_PAYLOAD_REQUIRED_FIELDS)).toHaveLength(22);
  });

  it("every payload contract includes evidence_refs (provenance, INV-1/§1)", () => {
    for (const [, fields] of Object.entries(AGENT_PAYLOAD_REQUIRED_FIELDS)) {
      expect(fields).toContain("evidence_refs");
    }
  });

  it("validateAgentPayload flags missing required fields", () => {
    const ok = validateAgentPayload("payment", {
      decision_context: decisionContext,
      amount: "100",
      currency: "USD",
      source_account_id: "acct_1",
      destination_counterparty_id: "cp_1",
      due_date: "2026-06-01",
      evidence_refs: [],
    });
    expect(ok.ok).toBe(true);

    const bad = validateAgentPayload("payment", { amount: "100" });
    expect(bad.ok).toBe(false);
    expect(bad.missing).toContain("currency");
    expect(bad.missing).toContain("evidence_refs");
  });

  it("treats an unknown agent as ok (agentProposal fallback)", () => {
    expect(validateAgentPayload("nonexistent", {}).ok).toBe(true);
  });

  it("validates AML compliance and subscription management payloads", () => {
    expect(
      validateAgentPayload("aml_compliance", {
        payment_id: "pi_1",
        decision_context: decisionContext,
        beneficiary_id: "cp_1",
        amount: "12000.00",
        currency: "USD",
        jurisdictions_involved: ["US"],
        screenings: {},
        required_documents: [],
        regulatory_context: {},
        recommended_action: "provide_docs",
        deadline: "2026-09-21T00:00:00.000Z",
        evidence_refs: [],
      }).ok,
    ).toBe(true);

    expect(
      validateAgentPayload("subscription_management", {
        subscription_id: "sub_1",
        decision_context: decisionContext,
        merchant: "Acme SaaS",
        current_plan: "Team",
        renewal_date: null,
        currency: "USD",
        current_price: "1200.00",
        options: [],
        recommended_action: "renew",
        evidence_refs: [],
      }).ok,
    ).toBe(true);
  });
});
