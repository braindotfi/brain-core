import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contentHashHex, evaluate, type Action, type PolicyDocument } from "@brain/policy";

const MONEY_MOVERS = [
  "treasury",
  "payment",
  "savings",
  "bill_management",
  "debt_optimization",
] as const;

function loadTemplate(agent: string): PolicyDocument {
  return JSON.parse(
    readFileSync(new URL(`./${agent}/policy.template.json`, import.meta.url), "utf8"),
  ) as PolicyDocument;
}

function action(overrides: Partial<Action>): Action {
  return {
    kind: "outbound_payment",
    counterparty_id: null,
    amount: null,
    agent_role: null,
    timestamp: new Date("2026-05-23T12:00:00Z"),
    ...overrides,
  };
}

describe("money-mover policy templates (1b.6)", () => {
  it("each loads, evaluates, and has a stable content hash", () => {
    for (const agent of MONEY_MOVERS) {
      const doc = loadTemplate(agent);
      expect(doc.version).toBe(1);
      expect(doc.rules.length).toBeGreaterThan(0);
      // EIP-712 inputs depend on a stable content hash — recompute must match.
      expect(contentHashHex(doc)).toBe(contentHashHex(doc));
      expect(contentHashHex(doc)).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("treasury: within-envelope auto, over-threshold confirm, outside-envelope reject", () => {
    const doc = loadTemplate("treasury");
    const within = action({
      agent_id: "treasury",
      amount: { currency: "USD", value: "5000" },
      spend_in_window: { "24h": { currency: "USD", value: "100000" } },
      tx_count_in_window: { "24h": 0 },
    });
    expect(evaluate(doc, within).outcome).toBe("allow");

    // > approval_required_above (25000) but still within caps → confirm.
    expect(evaluate(doc, { ...within, amount: { currency: "USD", value: "30000" } }).outcome).toBe(
      "confirm",
    );

    // over per-tx cap → outside envelope → financial reject.
    expect(evaluate(doc, { ...within, amount: { currency: "USD", value: "200000" } }).outcome).toBe(
      "reject",
    );

    // window already near cap → projected over → reject.
    expect(
      evaluate(doc, {
        ...within,
        spend_in_window: { "24h": { currency: "USD", value: "499000" } },
      }).outcome,
    ).toBe("reject");
  });

  it("savings: consumer-gated envelope; wrong category is denied", () => {
    const doc = loadTemplate("savings");
    const base = action({
      agent_id: "savings",
      tenant_category: "consumer",
      amount: { currency: "USD", value: "100" },
      spend_in_window: { "30d": { currency: "USD", value: "1000" } },
      tx_count_in_window: { "7d": 0 },
    });
    expect(evaluate(doc, base).outcome).toBe("allow");
    // above approval_required_above (500) → confirm
    expect(evaluate(doc, { ...base, amount: { currency: "USD", value: "1000" } }).outcome).toBe(
      "confirm",
    );
    // business tenant → tenant.category mismatch → outside envelope → reject
    expect(evaluate(doc, { ...base, tenant_category: "business" }).outcome).toBe("reject");
  });
});
