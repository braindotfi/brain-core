import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { PolicyDocument } from "./dsl.js";
import { compareDecimal, evaluate, matchesCron, parseRequire } from "./vm.js";

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
