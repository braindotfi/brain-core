/**
 * Tests for ERC-8004 reputation as a Policy threshold input (RFC 0001 §7.7).
 *
 * The headline property: `applyReputationAdjustment` is TIGHTEN-ONLY — it can add
 * approvers and lower caps, but can NEVER remove an approver, raise a cap, relax
 * verification, or turn a reject into an allow. A high / absent / gamed-high
 * reputation can therefore never weaken a control.
 */

import { describe, expect, it } from "vitest";
import type { GatePolicyDecision } from "@brain/shared";
import {
  applyReputationAdjustment,
  readReputationEnvelope,
  type ReputationEnvelope,
} from "./reputation.js";

function decision(overrides: Partial<GatePolicyDecision> = {}): GatePolicyDecision {
  return {
    id: "pd_1",
    outcome: "allow",
    matched_rule_id: "rule_1",
    required_approvers: [],
    ledger_snapshot_hash: "0xdead",
    trace: [{ rule: "rule_1" }],
    amount_upper_bound: null,
    counterparty_verification_threshold: null,
    ...overrides,
  };
}

const ENVELOPE: ReputationEnvelope = {
  min_score: 0.6,
  below: {
    add_approvers: ["cfo"],
    amount_cap: { currency: "USD", value: "100.00" },
    require_verification_above: { currency: "USD", value: "50.00" },
  },
};

describe("applyReputationAdjustment — no-op cases", () => {
  it("returns the decision unchanged when reputation is null", () => {
    const d = decision();
    expect(applyReputationAdjustment(d, null, ENVELOPE)).toBe(d);
  });

  it("returns unchanged when there is no envelope", () => {
    const d = decision();
    expect(applyReputationAdjustment(d, { score: 0.1 }, undefined)).toBe(d);
  });

  it("returns unchanged when the score is at/above min_score (reputable enough)", () => {
    const d = decision();
    expect(applyReputationAdjustment(d, { score: 0.6 }, ENVELOPE)).toBe(d);
    expect(applyReputationAdjustment(d, { score: 0.95 }, ENVELOPE)).toBe(d);
  });

  it("returns unchanged when the envelope has no `below` adjustments", () => {
    const d = decision();
    expect(applyReputationAdjustment(d, { score: 0.1 }, { min_score: 0.6 })).toBe(d);
  });
});

describe("applyReputationAdjustment — tightening (score below min_score)", () => {
  it("adds approvers and escalates allow → confirm", () => {
    const out = applyReputationAdjustment(decision(), { score: 0.2 }, ENVELOPE);
    expect(out.outcome).toBe("confirm");
    expect(out.required_approvers).toEqual(["cfo"]);
    expect(out.amount_upper_bound).toEqual({ currency: "USD", value: "100.00" });
    expect(out.counterparty_verification_threshold).toEqual({ currency: "USD", value: "50.00" });
  });

  it("unions approvers without duplicates and keeps an existing confirm outcome", () => {
    const out = applyReputationAdjustment(
      decision({ outcome: "confirm", required_approvers: ["cfo", "ceo"] }),
      { score: 0.2 },
      { min_score: 0.6, below: { add_approvers: ["cfo"] } },
    );
    // "cfo" already present → no change at all → same object.
    expect(out.required_approvers).toEqual(["cfo", "ceo"]);
  });

  it("lowers an existing amount cap but NEVER raises it", () => {
    const lower = applyReputationAdjustment(
      decision({ amount_upper_bound: { currency: "USD", value: "1000.00" } }),
      { score: 0.1 },
      { min_score: 0.6, below: { amount_cap: { currency: "USD", value: "100.00" } } },
    );
    expect(lower.amount_upper_bound).toEqual({ currency: "USD", value: "100.00" });

    const noRaise = applyReputationAdjustment(
      decision({ amount_upper_bound: { currency: "USD", value: "10.00" } }),
      { score: 0.1 },
      { min_score: 0.6, below: { amount_cap: { currency: "USD", value: "100.00" } } },
    );
    // base cap (10) is already tighter than the reputation cap (100) → keep base.
    expect(noRaise.amount_upper_bound).toEqual({ currency: "USD", value: "10.00" });
    expect(noRaise).toBe(noRaise); // unchanged path returns the same decision
  });

  it("imposes a cap where the base had none", () => {
    const out = applyReputationAdjustment(
      decision({ amount_upper_bound: null }),
      { score: 0.1 },
      { min_score: 0.6, below: { amount_cap: { currency: "USD", value: "250.00" } } },
    );
    expect(out.amount_upper_bound).toEqual({ currency: "USD", value: "250.00" });
  });

  it("imposes/lowers the verification threshold but never raises it", () => {
    const lowered = applyReputationAdjustment(
      decision({ counterparty_verification_threshold: { currency: "USD", value: "500.00" } }),
      { score: 0.1 },
      {
        min_score: 0.6,
        below: { require_verification_above: { currency: "USD", value: "50.00" } },
      },
    );
    expect(lowered.counterparty_verification_threshold).toEqual({
      currency: "USD",
      value: "50.00",
    });

    const noRaise = applyReputationAdjustment(
      decision({ counterparty_verification_threshold: { currency: "USD", value: "10.00" } }),
      { score: 0.1 },
      {
        min_score: 0.6,
        below: { require_verification_above: { currency: "USD", value: "50.00" } },
      },
    );
    expect(noRaise.counterparty_verification_threshold).toEqual({
      currency: "USD",
      value: "10.00",
    });
  });

  it("NEVER turns a reject into an allow (reject stays reject)", () => {
    const out = applyReputationAdjustment(
      decision({ outcome: "reject" }),
      { score: 0.0 },
      ENVELOPE,
    );
    expect(out.outcome).toBe("reject");
  });

  it("records the adjustment in the trace (audit proof)", () => {
    const out = applyReputationAdjustment(decision(), { score: 0.2, source: "0xroot" }, ENVELOPE);
    const last = out.trace[out.trace.length - 1] as Record<string, unknown>;
    const adj = last["reputation_adjustment"] as Record<string, unknown>;
    expect(adj.score).toBe(0.2);
    expect(adj.min_score).toBe(0.6);
    expect(adj.source).toBe("0xroot");
    expect(adj.applied).toContain("add_approvers");
    // The base trace entry is preserved.
    expect(out.trace[0]).toEqual({ rule: "rule_1" });
  });

  it("does not raise a cap when currencies differ (no cross-currency loosening)", () => {
    const out = applyReputationAdjustment(
      decision({ amount_upper_bound: { currency: "USD", value: "1000.00" } }),
      { score: 0.1 },
      { min_score: 0.6, below: { amount_cap: { currency: "EUR", value: "1.00" } } },
    );
    // Different currency → cannot compare → leave the USD bound untouched.
    expect(out.amount_upper_bound).toEqual({ currency: "USD", value: "1000.00" });
  });

  it("SAFETY property: never removes an approver and never raises a cap", () => {
    const base = decision({
      outcome: "confirm",
      required_approvers: ["cfo", "ceo", "controller"],
      amount_upper_bound: { currency: "USD", value: "42.00" },
    });
    const out = applyReputationAdjustment(base, { score: 0.0 }, ENVELOPE);
    // every base approver survives
    for (const r of base.required_approvers) expect(out.required_approvers).toContain(r);
    // the cap is never higher than the base
    const baseVal = Number(base.amount_upper_bound!.value);
    const outVal = Number(out.amount_upper_bound!.value);
    expect(outVal).toBeLessThanOrEqual(baseVal);
  });
});

describe("readReputationEnvelope", () => {
  it("returns undefined for non-objects / missing reputation / missing min_score", () => {
    expect(readReputationEnvelope(null)).toBeUndefined();
    expect(readReputationEnvelope("x")).toBeUndefined();
    expect(readReputationEnvelope({})).toBeUndefined();
    expect(readReputationEnvelope({ reputation: {} })).toBeUndefined();
    expect(readReputationEnvelope({ reputation: { min_score: "high" } })).toBeUndefined();
  });

  it("parses min_score only", () => {
    expect(readReputationEnvelope({ reputation: { min_score: 0.6 } })).toEqual({ min_score: 0.6 });
  });

  it("parses a full envelope and filters junk", () => {
    const env = readReputationEnvelope({
      reputation: {
        min_score: 0.5,
        below: {
          add_approvers: ["cfo", 7, "ceo"],
          amount_cap: { currency: "USD", value: "100.00" },
          require_verification_above: { currency: "USD", value: "50.00" },
          junk: "ignored",
        },
      },
    });
    expect(env).toEqual({
      min_score: 0.5,
      below: {
        add_approvers: ["cfo", "ceo"],
        amount_cap: { currency: "USD", value: "100.00" },
        require_verification_above: { currency: "USD", value: "50.00" },
      },
    });
  });

  it("drops a malformed amount_cap (not a bound)", () => {
    const env = readReputationEnvelope({
      reputation: { min_score: 0.5, below: { amount_cap: { value: "100.00" } } },
    });
    expect(env).toEqual({ min_score: 0.5, below: {} });
  });
});
