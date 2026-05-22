import { describe, expect, it } from "vitest";
import { resolveExecutionMode } from "./execution-mode.js";

const base = {
  confidence: 0.95,
  evidenceComplete: true,
  minimumConfidence: 0.75,
  riskLevel: "low" as const,
};

describe("resolveExecutionMode", () => {
  it("maps DENY to reject regardless of confidence/evidence", () => {
    expect(
      resolveExecutionMode({ ...base, decision: "DENY", confidence: 0.1, evidenceComplete: false }),
    ).toBe("reject");
  });

  it("returns notify_only when confidence is below the minimum", () => {
    expect(resolveExecutionMode({ ...base, decision: "ALLOW", confidence: 0.5 })).toBe(
      "notify_only",
    );
  });

  it("returns notify_only when required evidence is missing", () => {
    expect(resolveExecutionMode({ ...base, decision: "ALLOW", evidenceComplete: false })).toBe(
      "notify_only",
    );
  });

  it("maps ESCALATE to confirm when confidence + evidence are sufficient", () => {
    expect(resolveExecutionMode({ ...base, decision: "ESCALATE" })).toBe("confirm");
  });

  it("downgrades a low-confidence ESCALATE to notify_only", () => {
    expect(resolveExecutionMode({ ...base, decision: "ESCALATE", confidence: 0.5 })).toBe(
      "notify_only",
    );
  });

  it("maps ALLOW + high confidence + low risk to execute", () => {
    expect(resolveExecutionMode({ ...base, decision: "ALLOW" })).toBe("execute");
  });

  it("maps ALLOW + medium risk to propose", () => {
    expect(resolveExecutionMode({ ...base, decision: "ALLOW", riskLevel: "medium" })).toBe(
      "propose",
    );
  });

  it("maps ALLOW + medium confidence (above min, below high) to propose", () => {
    expect(resolveExecutionMode({ ...base, decision: "ALLOW", confidence: 0.8 })).toBe("propose");
  });

  it("honors a custom high-confidence threshold", () => {
    expect(
      resolveExecutionMode({
        ...base,
        decision: "ALLOW",
        confidence: 0.8,
        highConfidenceThreshold: 0.75,
      }),
    ).toBe("execute");
  });
});
