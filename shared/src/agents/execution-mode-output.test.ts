import { describe, expect, it } from "vitest";
import { resolveExecutionModeFromOutput } from "./execution-mode.js";
import type { AgentOutput } from "../contracts/agent-output.js";

function output(over: Partial<AgentOutput> = {}): AgentOutput {
  return {
    recommendation: {},
    confidence: 0.9,
    evidence_score: 0.9,
    missing_evidence: [],
    risk_level: "low",
    allowed_next_actions: ["propose_payment"],
    suggested_execution_mode: "execute",
    ...over,
  };
}

describe("resolveExecutionModeFromOutput (H-16)", () => {
  it("executes on high confidence + low risk + complete evidence", () => {
    expect(resolveExecutionModeFromOutput(output(), { minimumConfidence: 0.7 })).toBe("execute");
  });

  it("notify_only when evidence is missing", () => {
    const r = resolveExecutionModeFromOutput(
      output({ missing_evidence: [{ kind: "invoice", reason: "not attached" }] }),
      { minimumConfidence: 0.7 },
    );
    expect(r).toBe("notify_only");
  });

  it("notify_only when confidence is below the floor", () => {
    expect(
      resolveExecutionModeFromOutput(output({ confidence: 0.5 }), { minimumConfidence: 0.7 }),
    ).toBe("notify_only");
  });

  it("caps high/critical risk at confirm even if the agent suggested execute", () => {
    expect(
      resolveExecutionModeFromOutput(output({ risk_level: "high" }), { minimumConfidence: 0.7 }),
    ).toBe("confirm");
    expect(
      resolveExecutionModeFromOutput(output({ risk_level: "critical" }), {
        minimumConfidence: 0.7,
      }),
    ).toBe("confirm");
  });

  it("downgrades execute→propose when confidence is below the high threshold", () => {
    const r = resolveExecutionModeFromOutput(output({ confidence: 0.75 }), {
      minimumConfidence: 0.7,
      highConfidenceThreshold: 0.85,
    });
    expect(r).toBe("propose");
  });

  it("respects a lower suggested mode", () => {
    expect(
      resolveExecutionModeFromOutput(output({ suggested_execution_mode: "propose" }), {
        minimumConfidence: 0.7,
      }),
    ).toBe("propose");
  });
});
