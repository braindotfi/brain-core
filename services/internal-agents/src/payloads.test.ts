import { describe, expect, it } from "vitest";
import { internalAgentCatalog } from "./registry.js";
import { AGENT_PAYLOAD_REQUIRED_FIELDS, validateAgentPayload } from "./payloads.js";

describe("agent workflow payloads (2.1)", () => {
  it("every one of the 19 catalog agents has a payload contract", () => {
    for (const def of internalAgentCatalog) {
      expect(AGENT_PAYLOAD_REQUIRED_FIELDS[def.agent_key], def.agent_key).toBeDefined();
    }
    expect(Object.keys(AGENT_PAYLOAD_REQUIRED_FIELDS)).toHaveLength(19);
  });

  it("every payload contract includes evidence_refs (provenance, INV-1/§1)", () => {
    for (const [, fields] of Object.entries(AGENT_PAYLOAD_REQUIRED_FIELDS)) {
      expect(fields).toContain("evidence_refs");
    }
  });

  it("validateAgentPayload flags missing required fields", () => {
    const ok = validateAgentPayload("payment", {
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
});
