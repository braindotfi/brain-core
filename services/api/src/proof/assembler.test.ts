import { describe, expect, it } from "vitest";
import { assembleProof, deriveProofOutcome, type ProofSources } from "./assembler.js";

function sources(over: Partial<ProofSources> = {}): ProofSources {
  return {
    actionId: "pi_ACTION",
    tenantId: "tnt_x",
    paymentIntent: { id: "pi_ACTION", created_by_agent_id: "agent_1", status: "executed" },
    shadow: false,
    policyDecision: {
      policy_version: 3,
      matched_rule_id: "allow-small",
      ledger_snapshot_hash: "abc123",
      outcome: "allow",
    },
    policyHash: "deadbeef",
    behaviorHash: "0xbehv",
    gateChecks: [{ index: 1, name: "agent_identity_verified", passed: true }],
    evidence: [
      {
        raw_parsed_id: "prs_1",
        sha256: "ff".repeat(32),
        source_type: "plaid",
        kind: "invoice",
        trust_level: "high",
      },
    ],
    auditEvents: [
      {
        id: "evt_1",
        action: "payment_intent.execute.before",
        layer: "agent",
        event_hash: "aa",
        prev_event_hash: null,
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ],
    merkleRoot: "cc",
    merkleProof: ["dd"],
    chainAnchor: {
      tx_hash: "0xtx",
      block_number: 100,
      contract_address: "0xanchor",
      chain: "base-sepolia",
    },
    railReceipt: { rail: "ach", ach_trace: "t" },
    ...over,
  };
}

describe("assembleProof", () => {
  it("populates every field for an executed PaymentIntent", () => {
    const p = assembleProof(sources());
    expect(p.action_id).toBe("pi_ACTION");
    expect(p.agent_id).toBe("agent_1");
    expect(p.outcome).toBe("executed");
    expect(p.policy_version).toBe("3");
    expect(p.policy_hash).toBe("deadbeef");
    expect(p.matched_rule_id).toBe("allow-small");
    expect(p.ledger_snapshot_hash).toBe("abc123");
    expect(p.gate_checks).toHaveLength(1);
    expect(p.evidence[0]?.raw_parsed_id).toBe("prs_1");
    expect(p.merkle_root).toBe("cc");
    expect(p.chain_anchor?.chain).toBe("base-sepolia");
    expect(p.rail_receipt).toEqual({ rail: "ach", ach_trace: "t" });
    // human_explanation is rendered separately by the Wiki layer.
    expect("human_explanation" in p).toBe(false);
  });

  it("anchor-not-yet-published: chain_anchor null, proof still complete", () => {
    const p = assembleProof(sources({ chainAnchor: null }));
    expect(p.chain_anchor).toBeNull();
    expect(p.merkle_root).toBe("cc");
  });

  it("shadow-completed: outcome shadow_completed, rail_receipt forced null, anchor kept", () => {
    const p = assembleProof(
      sources({ shadow: true, railReceipt: { rail: "ach", ach_trace: "t" } }),
    );
    expect(p.outcome).toBe("shadow_completed");
    expect(p.rail_receipt).toBeNull();
    // Audit chain is independent of money movement.
    expect(p.chain_anchor).not.toBeNull();
  });

  it("missing policy decision degrades gracefully (empty strings, null rule)", () => {
    const p = assembleProof(sources({ policyDecision: null, policyHash: null }));
    expect(p.policy_version).toBe("");
    expect(p.policy_hash).toBe("");
    expect(p.matched_rule_id).toBeNull();
    expect(p.ledger_snapshot_hash).toBe("");
  });
});

describe("deriveProofOutcome", () => {
  it("maps lifecycle + policy verdict to the customer-facing outcome", () => {
    expect(deriveProofOutcome(sources({ paymentIntent: pi("executed") }))).toBe("executed");
    expect(deriveProofOutcome(sources({ paymentIntent: pi("failed") }))).toBe("failed");
    expect(deriveProofOutcome(sources({ paymentIntent: pi("rejected") }))).toBe("rejected");
    expect(
      deriveProofOutcome(
        sources({
          paymentIntent: pi("dispatching"),
          policyDecision: pd("confirm"),
        }),
      ),
    ).toBe("confirmed");
    expect(
      deriveProofOutcome(sources({ paymentIntent: pi("approved"), policyDecision: pd("allow") })),
    ).toBe("allowed");
    // Shadow overrides everything.
    expect(deriveProofOutcome(sources({ shadow: true, paymentIntent: pi("executed") }))).toBe(
      "shadow_completed",
    );
  });
});

function pi(status: string): ProofSources["paymentIntent"] {
  return { id: "pi_ACTION", created_by_agent_id: "agent_1", status };
}
function pd(outcome: "allow" | "confirm" | "reject"): ProofSources["policyDecision"] {
  return { policy_version: 3, matched_rule_id: "r", ledger_snapshot_hash: "h", outcome };
}
