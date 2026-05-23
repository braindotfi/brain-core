/**
 * Adversarial fixtures (Agent Autonomy v3, 3.1) — execution-layer protections.
 */

import { describe, expect, it } from "vitest";
import { buildProposalDedupKey } from "./agent-runs.js";
import { isValidPaymentIntentTransition } from "./payment-intents/state-machine.js";

describe("3.1 LLM nondeterminism — near-identical proposals collide on the dedup key", () => {
  it("two slightly different amounts in the same window produce the same proposal dedup key", () => {
    const base = {
      tenantId: "tnt_acme",
      agentId: "payment",
      counterpartyId: "cp_1",
      currency: "USD",
      day: "2026-05-23",
    };
    // The LLM emits $100.40 on one run and $100.49 on a retry — amount_bucket
    // rounds both to 100, so the proposal-layer unique constraint dedups them.
    const a = buildProposalDedupKey({ ...base, amount: "100.40" });
    const b = buildProposalDedupKey({ ...base, amount: "100.49" });
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  it("an obligation-keyed proposal is stable across runs", () => {
    const k1 = buildProposalDedupKey({ tenantId: "t", agentId: "payment", obligationId: "obl_1" });
    const k2 = buildProposalDedupKey({ tenantId: "t", agentId: "payment", obligationId: "obl_1" });
    expect(k1).toBe(k2);
  });
});

describe("3.1 halt race — a paused intent can never reach executed", () => {
  it("approved → paused is allowed (halt), but paused → executed is forbidden", () => {
    expect(isValidPaymentIntentTransition("approved", "paused")).toBe(true);
    // Even if /halt fires between approve and dispatch, the state machine + the
    // rail-dispatch re-read guard prevent a paused intent from executing.
    expect(isValidPaymentIntentTransition("paused", "executed")).toBe(false);
    // Resume must re-enter approved (re-running the live gate) first.
    expect(isValidPaymentIntentTransition("paused", "approved")).toBe(true);
  });
});
