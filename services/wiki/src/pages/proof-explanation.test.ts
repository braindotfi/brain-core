import { describe, expect, it } from "vitest";
import { renderProofExplanation, type ProofExplanationInput } from "./proof-explanation.js";

function core(over: Partial<ProofExplanationInput> = {}): ProofExplanationInput {
  return {
    action_id: "pi_ACTION",
    tenant_id: "tnt_x",
    agent_id: "agent_1",
    behavior_hash: "0xb",
    outcome: "executed",
    policy_version: "3",
    policy_hash: "deadbeef",
    matched_rule_id: "allow-small",
    gate_checks: [
      { index: 1, name: "agent_identity_verified", passed: true },
      { index: 2, name: "agent_authorized", passed: true },
    ],
    evidence: [
      {
        raw_parsed_id: "prs_1",
        sha256: "ff",
        source_type: "plaid",
        kind: "invoice",
        trust_level: "high",
      },
    ],
    ledger_snapshot_hash: "abc",
    audit_events: [],
    merkle_root: "cc",
    merkle_proof: ["dd"],
    chain_anchor: {
      tx_hash: "0xtx",
      block_number: 1,
      contract_address: "0xa",
      chain: "base-sepolia",
    },
    rail_receipt: { rail: "ach", ach_trace: "t" },
    ...over,
  };
}

describe("renderProofExplanation", () => {
  it("describes an executed, anchored action in 2-4 sentences", () => {
    const text = renderProofExplanation(core());
    expect(text).toContain("agent_1");
    expect(text).toContain("pi_ACTION");
    expect(text).toContain("executed");
    expect(text).toContain("2 of 2");
    expect(text).toContain("base-sepolia");
    expect(text).toContain("0xtx");
    const sentenceCount = text.split(". ").length;
    expect(sentenceCount).toBeGreaterThanOrEqual(2);
    expect(sentenceCount).toBeLessThanOrEqual(4);
  });

  it("notes pending anchor when chain_anchor is null", () => {
    const text = renderProofExplanation(core({ chain_anchor: null }));
    expect(text).toContain("once the next batch is anchored");
    expect(text).not.toContain("0xtx");
  });

  it("frames a shadow run as recorded-but-no-money-moved", () => {
    const text = renderProofExplanation(core({ outcome: "shadow_completed", rail_receipt: null }));
    expect(text).toContain("shadow mode");
    expect(text).not.toContain("settlement receipt");
  });

  it("frames a rejected action", () => {
    const text = renderProofExplanation(core({ outcome: "rejected" }));
    expect(text).toContain("rejected by the pre-execution gate");
  });

  it.each([
    ["failed", "rail reported a failure"],
    ["confirmed", "awaiting the required human confirmation"],
    ["allowed", "allowed by policy and gated"],
  ] as const)("frames a %s action", (outcome, phrase) => {
    const text = renderProofExplanation(core({ outcome }));
    expect(text).toContain(phrase);
  });

  it("uses a generic subject + omits the rule clause when agent_id and rule are empty/null", () => {
    const text = renderProofExplanation(core({ agent_id: "", matched_rule_id: null }));
    expect(text).toContain("An agent's action");
    expect(text).not.toContain(" under rule ");
  });

  it("falls back to 'unknown' policy version and pluralizes evidence", () => {
    const text = renderProofExplanation(
      core({
        policy_version: "",
        evidence: [
          { raw_parsed_id: "p1", sha256: "a", source_type: "plaid", kind: "invoice", trust_level: "high" },
          { raw_parsed_id: "p2", sha256: "b", source_type: "plaid", kind: "receipt", trust_level: "high" },
        ],
      }),
    );
    expect(text).toContain("policy version unknown");
    expect(text).toContain("2 evidence artifacts");
  });

  it("singular evidence + no settlement sentence when executed without a rail receipt", () => {
    const text = renderProofExplanation(core({ rail_receipt: null }));
    expect(text).toContain("1 evidence artifact."); // singular (no trailing 's')
    expect(text).not.toContain("1 evidence artifacts");
    expect(text).not.toContain("settlement receipt");
  });
});
