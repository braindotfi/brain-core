import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { PolicyDocument } from "./dsl.js";
import { addDecimal, compareDecimal, evaluate, matchesCron, parseRequire } from "./vm.js";

import type { Action } from "./vm.js";

function baseAction(overrides: Partial<Action> = {}): Action {
  return {
    kind: "outbound_payment",
    counterparty_id: null,
    amount: null,
    agent_role: null,
    timestamp: new Date("2026-05-23T12:00:00Z"),
    ...overrides,
  };
}

describe("compareDecimal", () => {
  it("handles equal values", () => {
    expect(compareDecimal("0", "0")).toBe(0);
    expect(compareDecimal("1.5", "1.50")).toBe(0);
    expect(compareDecimal("100", "100.000")).toBe(0);
  });
  it("handles signed values", () => {
    expect(compareDecimal("-1", "0")).toBe(-1);
    expect(compareDecimal("0", "-0.5")).toBe(1);
    expect(compareDecimal("-10", "-5")).toBe(-1);
  });
  it("property: total order", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        (a, b) => {
          const cmp = compareDecimal(String(a), String(b));
          if (a < b) expect(cmp).toBe(-1);
          else if (a > b) expect(cmp).toBe(1);
          else expect(cmp).toBe(0);
        },
      ),
    );
  });
  it("property: decimal precision beyond f64", () => {
    // Float arithmetic would mis-compare these; our normalizer shouldn't.
    expect(compareDecimal("0.1", "0.10000000000000001")).toBe(-1);
    expect(compareDecimal("0.1", "0.1")).toBe(0);
  });
});

describe("parseRequire", () => {
  it("handles known shapes", () => {
    expect(parseRequire("single_signer")).toEqual(["signer"]);
    expect(parseRequire("cfo_approval")).toEqual(["cfo"]);
    expect(parseRequire("cfo_and_ceo")).toEqual(["cfo", "ceo"]);
  });
});

describe("matchesCron (5-field subset)", () => {
  it("accepts stars for any value", () => {
    expect(matchesCron("* * * * *", new Date("2026-04-24T12:34:00Z"))).toBe(true);
  });
  it("matches literals in UTC", () => {
    expect(matchesCron("0 12 * * *", new Date("2026-04-24T12:00:00Z"))).toBe(true);
    expect(matchesCron("0 12 * * *", new Date("2026-04-24T12:01:00Z"))).toBe(false);
  });
  it("accepts comma lists", () => {
    expect(matchesCron("0,30 * * * *", new Date("2026-04-24T10:00:00Z"))).toBe(true);
    expect(matchesCron("0,30 * * * *", new Date("2026-04-24T10:30:00Z"))).toBe(true);
    expect(matchesCron("0,30 * * * *", new Date("2026-04-24T10:15:00Z"))).toBe(false);
  });
  it("rejects malformed expressions", () => {
    expect(matchesCron("broken", new Date())).toBe(false);
    expect(matchesCron("* * *", new Date())).toBe(false);
  });
});

describe("evaluate — default deny when no rule matches", () => {
  it("returns reject with trace", () => {
    const policy: PolicyDocument = { version: 1, rules: [] };
    const d = evaluate(policy, {
      kind: "outbound_payment",
      counterparty_id: null,
      amount: null,
      agent_role: null,
      timestamp: new Date(),
    });
    expect(d.outcome).toBe("reject");
    expect(d.matched_rule_id).toBeNull();
  });
});

describe("evaluate — amount.lte allow (auto)", () => {
  it("matches and returns allow", () => {
    const policy: PolicyDocument = {
      version: 1,
      rules: [
        {
          id: "small-payments-ok",
          applies_to: ["outbound_payment"],
          when: { "amount.lte": { currency: "USD", value: "100.00" } },
          execute: "auto",
        },
      ],
    };
    const d = evaluate(policy, {
      kind: "outbound_payment",
      counterparty_id: null,
      amount: { currency: "USD", value: "50" },
      agent_role: null,
      timestamp: new Date(),
    });
    expect(d.outcome).toBe("allow");
    expect(d.matched_rule_id).toBe("small-payments-ok");
  });
});

describe("evaluate — confirm when require is present and execute=auto", () => {
  it("downgrades to confirm when approvers are required", () => {
    const policy: PolicyDocument = {
      version: 1,
      rules: [
        {
          id: "big-payments",
          applies_to: ["outbound_payment"],
          when: { "amount.gt": { currency: "USD", value: "10000.00" } },
          require: "cfo_approval",
          execute: "auto",
        },
      ],
    };
    const d = evaluate(policy, {
      kind: "outbound_payment",
      counterparty_id: null,
      amount: { currency: "USD", value: "50000" },
      agent_role: null,
      timestamp: new Date(),
    });
    expect(d.outcome).toBe("confirm");
    expect(d.required_approvers).toEqual(["cfo"]);
  });
});

describe("evaluate — reject terminates early", () => {
  it("returns reject and stops scanning", () => {
    const policy: PolicyDocument = {
      version: 1,
      rules: [
        {
          id: "block-sanctioned",
          applies_to: ["any"],
          when: { "counterparty.not_in": "vendors.blocked" },
          execute: "auto",
        },
      ],
      lists: { "vendors.blocked": ["cp_evil"] },
    };
    const d = evaluate(policy, {
      kind: "onchain_tx",
      counterparty_id: "cp_evil",
      amount: null,
      agent_role: null,
      timestamp: new Date(),
    });
    // counterparty.not_in fails for cp_evil → rule doesn't match → default deny.
    expect(d.outcome).toBe("reject");
  });
});

describe("evaluate — counterparty.in list membership", () => {
  it("matches when counterparty is in the allowed list", () => {
    const policy: PolicyDocument = {
      version: 1,
      rules: [
        {
          id: "trusted-vendors",
          applies_to: ["outbound_payment"],
          when: { "counterparty.in": "vendors.trusted" },
          execute: "auto",
        },
      ],
      lists: { "vendors.trusted": ["cp_aws", "cp_google"] },
    };
    const d = evaluate(policy, {
      kind: "outbound_payment",
      counterparty_id: "cp_aws",
      amount: null,
      agent_role: null,
      timestamp: new Date(),
    });
    expect(d.outcome).toBe("allow");
  });
});

describe("evaluate — property: reject is the default for unmatched actions", () => {
  it("any action against empty policy is rejected", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("outbound_payment", "inbound_payment", "ledger_write", "onchain_tx"),
        (kind) => {
          const d = evaluate(
            { version: 1, rules: [] },
            {
              kind: kind as "outbound_payment" | "inbound_payment" | "ledger_write" | "onchain_tx",
              counterparty_id: null,
              amount: null,
              agent_role: null,
              timestamp: new Date(),
            },
          );
          expect(d.outcome).toBe("reject");
        },
      ),
    );
  });
});

describe("addDecimal (spend-envelope projection)", () => {
  it("adds without floating-point error", () => {
    expect(addDecimal("100.40", "0.20")).toBe("100.6");
    expect(addDecimal("0.1", "0.2")).toBe("0.3");
    expect(addDecimal("99999", "1")).toBe("100000");
    expect(addDecimal("0", "0")).toBe("0");
  });
});

describe("evaluate — 1b.5 signed authority primitives", () => {
  it("matches agent.id and tenant.category", () => {
    const policy: PolicyDocument = {
      version: 1,
      rules: [
        {
          id: "treasury-business",
          applies_to: ["any"],
          when: { "agent.id": "treasury", "tenant.category": "business" },
          execute: "auto",
        },
      ],
    };
    expect(
      evaluate(policy, baseAction({ agent_id: "treasury", tenant_category: "business" })).outcome,
    ).toBe("allow");
    // wrong category → no match → default deny
    expect(
      evaluate(policy, baseAction({ agent_id: "treasury", tenant_category: "consumer" })).outcome,
    ).toBe("reject");
  });

  it("enforces action.in allowlist and action.not_in blocklist", () => {
    const allow: PolicyDocument = {
      version: 1,
      rules: [
        {
          id: "a",
          applies_to: ["any"],
          when: { "action.in": ["propose_payment"] },
          execute: "auto",
        },
      ],
    };
    expect(evaluate(allow, baseAction({ action_id: "propose_payment" })).outcome).toBe("allow");
    expect(evaluate(allow, baseAction({ action_id: "execute_payment" })).outcome).toBe("reject");

    const block: PolicyDocument = {
      version: 1,
      rules: [
        {
          id: "b",
          applies_to: ["any"],
          when: { "action.not_in": ["execute_payment"] },
          execute: "auto",
        },
      ],
    };
    expect(evaluate(block, baseAction({ action_id: "execute_payment" })).outcome).toBe("reject");
    expect(evaluate(block, baseAction({ action_id: "propose_payment" })).outcome).toBe("allow");
  });

  it("pins to a behaviorHash", () => {
    const policy: PolicyDocument = {
      version: 1,
      rules: [
        { id: "p", applies_to: ["any"], when: { "agent.behaviorHash": "0xabc" }, execute: "auto" },
      ],
    };
    expect(evaluate(policy, baseAction({ behavior_hash: "0xabc" })).outcome).toBe("allow");
    expect(evaluate(policy, baseAction({ behavior_hash: "0xdef" })).outcome).toBe("reject");
  });

  it("matches a spend envelope while within the window cap and rejects when exceeded", () => {
    const policy: PolicyDocument = {
      version: 1,
      rules: [
        {
          id: "envelope",
          applies_to: ["outbound_payment"],
          when: {
            "agent.id": "treasury",
            "agent.spend_in_window": { window: "24h", lte: { currency: "USD", value: "100000" } },
          },
          execute: "confirm",
        },
      ],
    };
    // prior 90k + this 5k = 95k <= 100k → match → confirm
    expect(
      evaluate(
        policy,
        baseAction({
          agent_id: "treasury",
          amount: { currency: "USD", value: "5000" },
          spend_in_window: { "24h": { currency: "USD", value: "90000" } },
        }),
      ).outcome,
    ).toBe("confirm");
    // prior 98k + this 5k = 103k > 100k → no match → default deny
    expect(
      evaluate(
        policy,
        baseAction({
          agent_id: "treasury",
          amount: { currency: "USD", value: "5000" },
          spend_in_window: { "24h": { currency: "USD", value: "98000" } },
        }),
      ).outcome,
    ).toBe("reject");
  });

  it("fails closed when the action currency differs from the spend-envelope currency", () => {
    const policy: PolicyDocument = {
      version: 1,
      rules: [
        {
          id: "usd-envelope",
          applies_to: ["outbound_payment"],
          when: {
            "agent.id": "treasury",
            "agent.spend_in_window": { window: "24h", lte: { currency: "USD", value: "1000" } },
          },
          execute: "auto",
        },
      ],
    };
    // A 5000 EUR payment must NOT slip past a USD envelope by contributing 0 to
    // the projected spend. A mismatched currency cannot be proven within-envelope,
    // so the rule must not match → default deny.
    expect(
      evaluate(
        policy,
        baseAction({
          agent_id: "treasury",
          amount: { currency: "EUR", value: "5000" },
          spend_in_window: { "24h": { currency: "USD", value: "0" } },
        }),
      ).outcome,
    ).toBe("reject");
    // Control: a same-currency spend within the envelope still allows.
    expect(
      evaluate(
        policy,
        baseAction({
          agent_id: "treasury",
          amount: { currency: "USD", value: "500" },
          spend_in_window: { "24h": { currency: "USD", value: "0" } },
        }),
      ).outcome,
    ).toBe("allow");
  });

  it("enforces a tx-count window cap (this action counts)", () => {
    const policy: PolicyDocument = {
      version: 1,
      rules: [
        {
          id: "count",
          applies_to: ["any"],
          when: { "agent.tx_count_in_window": { window: "1h", lte: 10 } },
          execute: "auto",
        },
      ],
    };
    expect(evaluate(policy, baseAction({ tx_count_in_window: { "1h": 9 } })).outcome).toBe("allow");
    expect(evaluate(policy, baseAction({ tx_count_in_window: { "1h": 10 } })).outcome).toBe(
      "reject",
    );
  });

  it("approval_required_above forces confirm even when execute=auto", () => {
    const policy: PolicyDocument = {
      version: 1,
      rules: [
        {
          id: "auto-with-threshold",
          applies_to: ["outbound_payment"],
          when: { "agent.id": "savings" },
          execute: "auto",
          approval_required_above: { currency: "USD", value: "1000" },
        },
      ],
    };
    // below threshold → allow
    expect(
      evaluate(
        policy,
        baseAction({ agent_id: "savings", amount: { currency: "USD", value: "500" } }),
      ).outcome,
    ).toBe("allow");
    // above threshold → confirm + a required signer
    const over = evaluate(
      policy,
      baseAction({ agent_id: "savings", amount: { currency: "USD", value: "5000" } }),
    );
    expect(over.outcome).toBe("confirm");
    expect(over.required_approvers).toEqual(["signer"]);
  });
});
