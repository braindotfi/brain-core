/**
 * P0.7 — proof viewer render test. Pure function, no DB.
 */

import { describe, expect, it } from "vitest";
import type { Proof } from "@brain/shared";
import { renderProofHtml } from "./view.js";

function fixture(over: Partial<Proof> = {}): Proof {
  return {
    action_id: "pi_123",
    tenant_id: "tnt_a",
    agent_id: "agent_pay",
    behavior_hash: "0xbeef",
    outcome: "executed",
    policy_version: "3",
    policy_hash: "0xpolicy",
    matched_rule_id: "rule_small",
    gate_checks: [
      { index: 1, name: "agent_identity_verified", passed: true },
      {
        index: 11,
        name: "approval_granted_when_required",
        passed: true,
        detail: { required: ["cfo"] },
      },
    ],
    evidence: [
      {
        raw_parsed_id: "prs_1",
        sha256: "abc123",
        source_type: "pdf",
        kind: "invoice",
        trust_level: "high",
      },
    ],
    ledger_snapshot_hash: "0xsnap",
    audit_events: [
      {
        id: "ae_1",
        action: "payment_intent.execute.before",
        layer: "agent",
        event_hash: "deadbeefdeadbeef00",
        prev_event_hash: null,
        created_at: "2026-05-25T00:00:00Z",
      },
    ],
    merkle_root: "0xroot",
    merkle_proof: ["0xp1", "0xp2"],
    chain_anchor: {
      tx_hash: "0xtx",
      block_number: 42,
      contract_address: "0xanchor",
      chain: "base-sepolia",
    },
    rail_receipt: { rail: "bank_ach", external_id: "tr_1", state: "settled" },
    human_explanation: "Agent paid invoice for <AWS>.",
    ...over,
  };
}

describe("renderProofHtml (P0.7)", () => {
  it("renders every section heading", () => {
    const html = renderProofHtml(fixture());
    for (const heading of [
      "Brain Action Proof",
      "Agent",
      "Policy decision",
      "§6 gate trace",
      "Evidence",
      "Rail receipt",
      "Audit chain",
      "Merkle",
      "Verification",
    ]) {
      expect(html).toContain(heading);
    }
  });

  it("includes the action id, gate checks, evidence, and audit events", () => {
    const html = renderProofHtml(fixture());
    expect(html).toContain("pi_123");
    expect(html).toContain("agent_identity_verified");
    expect(html).toContain("approval_granted_when_required");
    expect(html).toContain("invoice");
    expect(html).toContain("payment_intent.execute.before");
    expect(html).toContain("0xroot");
  });

  it("links the anchor tx to the block explorer and shows the anchored badge", () => {
    const html = renderProofHtml(fixture());
    expect(html).toContain("https://sepolia.basescan.org/tx/0xtx");
    expect(html).toContain("Anchored on-chain");
  });

  it("shows a pending badge and no tx link when not yet anchored", () => {
    const html = renderProofHtml(fixture({ chain_anchor: null }));
    expect(html).toContain("on-chain anchor pending");
    expect(html).not.toContain("basescan.org/tx/");
  });

  it("escapes HTML in dynamic content (no injection)", () => {
    const html = renderProofHtml(fixture());
    expect(html).toContain("&lt;AWS&gt;");
    expect(html).not.toContain("invoice for <AWS>");
  });

  it("is a complete HTML document", () => {
    const html = renderProofHtml(fixture());
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("</html>");
  });
});
