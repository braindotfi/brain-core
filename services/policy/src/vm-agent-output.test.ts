import { describe, expect, it } from "vitest";
import { evaluate, type Action } from "./vm.js";
import type { PolicyDocument } from "./dsl.js";

function action(over: Partial<Action> = {}): Action {
  return {
    kind: "agent_action" as Action["kind"],
    counterparty_id: null,
    amount: null,
    agent_role: null,
    timestamp: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

const rule = (when: PolicyDocument["rules"][number]["when"]): PolicyDocument => ({
  version: 1,
  rules: [{ id: "gate", applies_to: ["any"], when, execute: "auto" }],
});

describe("H-16 agent-output policy primitives", () => {
  it("agent.confidence.gte matches at/above and rejects below", () => {
    const p = rule({ "agent.confidence.gte": 0.8 });
    expect(evaluate(p, action({ confidence: 0.9 })).outcome).toBe("allow");
    expect(evaluate(p, action({ confidence: 0.5 })).outcome).toBe("reject");
  });

  it("agent.confidence.gte fails closed when confidence is missing", () => {
    expect(evaluate(rule({ "agent.confidence.gte": 0.8 }), action({})).outcome).toBe("reject");
  });

  it("agent.evidence_score.gte gates on evidence completeness", () => {
    const p = rule({ "agent.evidence_score.gte": 0.7 });
    expect(evaluate(p, action({ evidence_score: 0.75 })).outcome).toBe("allow");
    expect(evaluate(p, action({ evidence_score: 0.4 })).outcome).toBe("reject");
  });

  it("agent.risk_level.lte caps risk (low ≤ medium passes; high > medium fails)", () => {
    const p = rule({ "agent.risk_level.lte": "medium" });
    expect(evaluate(p, action({ risk_level: "low" })).outcome).toBe("allow");
    expect(evaluate(p, action({ risk_level: "medium" })).outcome).toBe("allow");
    expect(evaluate(p, action({ risk_level: "high" })).outcome).toBe("reject");
    expect(evaluate(p, action({ risk_level: "critical" })).outcome).toBe("reject");
  });

  it("agent.risk_level.lte fails closed when risk is missing", () => {
    expect(evaluate(rule({ "agent.risk_level.lte": "medium" }), action({})).outcome).toBe("reject");
  });

  it("combines with other primitives (all must pass)", () => {
    const p = rule({ "agent.confidence.gte": 0.8, "agent.risk_level.lte": "low" });
    expect(evaluate(p, action({ confidence: 0.9, risk_level: "low" })).outcome).toBe("allow");
    expect(evaluate(p, action({ confidence: 0.9, risk_level: "high" })).outcome).toBe("reject");
  });
});
