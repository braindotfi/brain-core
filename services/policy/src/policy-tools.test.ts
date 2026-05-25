import { describe, expect, it } from "vitest";
import type { PolicyDocument, PolicyRule } from "./dsl.js";
import type { Action } from "./vm.js";
import { simulateHistorical, type ReplayAction } from "./simulator.js";
import { lintPolicy } from "./linter.js";
import { diffPolicies } from "./policy-diff.js";

function doc(rules: PolicyRule[], extra: Partial<PolicyDocument> = {}): PolicyDocument {
  return { version: 1, rules, ...extra };
}
function action(over: Partial<Action> = {}): Action {
  return {
    kind: "outbound_payment",
    counterparty_id: "cp_1",
    amount: { currency: "USD", value: "100.00" },
    agent_role: "payment",
    timestamp: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// simulateHistorical
// ---------------------------------------------------------------------------
describe("simulateHistorical", () => {
  const candidate = doc([
    {
      id: "allow-small",
      applies_to: ["outbound_payment"],
      when: { "amount.lte": { currency: "USD", value: "500" } },
      execute: "auto",
    },
  ]);
  const active = doc([{ id: "reject-all", applies_to: ["any"], when: {}, execute: "reject" }]);

  it("tallies outcomes and diffs vs the active policy", () => {
    const actions: ReplayAction[] = [
      { id: "pi_1", action: action({ amount: { currency: "USD", value: "100" } }) }, // candidate: allow
      { id: "pi_2", action: action({ amount: { currency: "USD", value: "900" } }) }, // candidate: reject (no rule)
    ];
    const r = simulateHistorical(candidate, active, actions);
    expect(r.total).toBe(2);
    expect(r.would_allow).toBe(1);
    expect(r.would_reject).toBe(1);
    // pi_1: active rejected → candidate allows → newly_allowed.
    expect(r.diff_vs_active.newly_allowed).toEqual(["pi_1"]);
    // pi_2: both reject → unchanged.
    expect(r.diff_vs_active.unchanged).toBe(1);
  });

  it("omits diff buckets when there is no active policy", () => {
    const r = simulateHistorical(candidate, null, [{ id: "pi_1", action: action() }]);
    expect(r.would_allow).toBe(1);
    expect(r.diff_vs_active.newly_allowed).toEqual([]);
    expect(r.diff_vs_active.unchanged).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// lintPolicy — exercise every code
// ---------------------------------------------------------------------------
describe("lintPolicy", () => {
  const codes = (findings: ReturnType<typeof lintPolicy>): string[] => findings.map((f) => f.code);

  it("auto mover with no amount cap / counterparty / verified / risk → errors", () => {
    const f = lintPolicy(
      doc([{ id: "r", applies_to: ["outbound_payment"], when: {}, execute: "auto" }]),
    );
    expect(codes(f)).toEqual(
      expect.arrayContaining([
        "auto_no_amount_cap",
        "auto_no_counterparty_constraint",
        "auto_no_verified_counterparty",
        "no_approval_path_high_value",
        "auto_no_risk_bound",
      ]),
    );
  });

  it("unsupported currency → error", () => {
    const f = lintPolicy(
      doc([
        {
          id: "r",
          applies_to: ["outbound_payment"],
          when: { "amount.lte": { currency: "XYZ", value: "10" } },
          execute: "confirm",
        },
      ]),
    );
    expect(codes(f)).toContain("unsupported_currency");
  });

  it("invalid approval role → error", () => {
    const f = lintPolicy(
      doc([
        {
          id: "r",
          applies_to: ["outbound_payment"],
          when: { "amount.lte": { currency: "USD", value: "10" } },
          require: "wizard_approval",
          execute: "confirm",
        },
      ]),
    );
    expect(codes(f)).toContain("invalid_approval_role");
  });

  it("broad any rule auto-executing → error", () => {
    const f = lintPolicy(doc([{ id: "r", applies_to: ["any"], when: {}, execute: "auto" }]));
    expect(codes(f)).toContain("broad_any_auto");
  });

  it("rule after a catch-all → unreachable WARN", () => {
    const f = lintPolicy(
      doc([
        { id: "catch", applies_to: ["any"], when: {}, execute: "reject" },
        {
          id: "later",
          applies_to: ["outbound_payment"],
          when: { "amount.lte": { currency: "USD", value: "10" } },
          execute: "confirm",
        },
      ]),
    );
    const u = f.find((x) => x.code === "unreachable_rule");
    expect(u?.rule_id).toBe("later");
    expect(u?.severity).toBe("WARN");
  });

  it("zero recent matches → WARN only when counts supplied", () => {
    const policy = doc([
      {
        id: "r",
        applies_to: ["outbound_payment"],
        when: { "amount.lte": { currency: "USD", value: "10" } },
        require: "approver_approval",
        execute: "confirm",
      },
    ]);
    expect(codes(lintPolicy(policy))).not.toContain("zero_recent_matches");
    const withCounts = lintPolicy(policy, { recentMatchCounts: { r: 0 } });
    expect(codes(withCounts)).toContain("zero_recent_matches");
  });

  it("a tight, fully-constrained auto rule produces no ERRORs", () => {
    const safe = doc([
      {
        id: "safe",
        applies_to: ["outbound_payment"],
        when: {
          "amount.lte": { currency: "USD", value: "500" },
          "counterparty.in": "vendors.trusted",
          "agent.risk_level.lte": "low",
        } as PolicyRule["when"],
        execute: "auto",
      },
    ]);
    const errors = lintPolicy(safe).filter((x) => x.severity === "ERROR");
    expect(errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// diffPolicies
// ---------------------------------------------------------------------------
describe("diffPolicies", () => {
  it("reports added, removed, and per-field modified", () => {
    const from = doc([
      {
        id: "a",
        applies_to: ["outbound_payment"],
        when: { "amount.lte": { currency: "USD", value: "100" } },
        execute: "auto",
      },
      { id: "b", applies_to: ["any"], when: {}, execute: "reject" },
    ]);
    const to = doc([
      {
        id: "a",
        applies_to: ["outbound_payment"],
        when: { "amount.lte": { currency: "USD", value: "250" } },
        execute: "confirm",
      },
      { id: "c", applies_to: ["onchain_tx"], when: {}, execute: "reject" },
    ]);
    const d = diffPolicies(from, to);
    expect(d.added.map((r) => r.id)).toEqual(["c"]);
    expect(d.removed.map((r) => r.id)).toEqual(["b"]);
    const a = d.modified.find((m) => m.id === "a");
    expect(a?.changes.map((c) => c.field).sort()).toEqual(["execute", "when"]);
  });
});
