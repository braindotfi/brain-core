import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluate, type Action, type PolicyDocument } from "@brain/policy";

function loadPolicy(rel: string): PolicyDocument {
  return JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8")) as PolicyDocument;
}

function subscriptionAction(): Action {
  return {
    kind: "ledger_write",
    counterparty_id: "cp_1",
    amount: null,
    agent_role: "subscription",
    timestamp: new Date("2026-05-22T12:00:00Z"),
  };
}

// Restrictiveness ordering for a policy outcome (higher = more restrictive).
const RANK: Record<"allow" | "confirm" | "reject", number> = {
  allow: 0,
  confirm: 1,
  reject: 2,
};

describe("consumer policy templates are more restrictive than business (same agent)", () => {
  it("Subscription: business template auto-allows, consumer template requires confirmation", () => {
    const business = evaluate(
      loadPolicy("./subscription/policy.template.json"),
      subscriptionAction(),
    );
    const consumer = evaluate(
      loadPolicy("./subscription/policy.consumer.template.json"),
      subscriptionAction(),
    );
    expect(business.outcome).toBe("allow");
    expect(consumer.outcome).toBe("confirm");
    // The consumer grant is strictly more restrictive.
    expect(RANK[consumer.outcome]).toBeGreaterThan(RANK[business.outcome]);
  });
});
