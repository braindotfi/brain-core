import { describe, expect, it } from "vitest";
import {
  resolveExecutionMode,
  resolveFinalExecutionMode,
  type FinalExecutionModeInput,
} from "./execution-mode.js";

function finalBase(overrides: Partial<FinalExecutionModeInput> = {}): FinalExecutionModeInput {
  return {
    suggestedMode: "execute",
    agentDefaultAuthority: "execute",
    gateDryRunOutcome: "allow",
    evidenceComplete: true,
    criticalMissing: false,
    confidence: 0.95,
    riskLevel: "low",
    counterpartyRisk: "low",
    actionKind: "financial",
    behaviorHashMatches: true,
    ...overrides,
  };
}

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

describe("resolveFinalExecutionMode (1b.4 hard constraints)", () => {
  it("reaches execute only when every precondition holds", () => {
    expect(resolveFinalExecutionMode(finalBase())).toBe("execute");
  });

  it("behaviorHash mismatch is a hard reject (beats everything)", () => {
    expect(
      resolveFinalExecutionMode(
        finalBase({ behaviorHashMatches: false, gateDryRunOutcome: "allow" }),
      ),
    ).toBe("reject");
  });

  it("gate dry-run reject → reject", () => {
    expect(resolveFinalExecutionMode(finalBase({ gateDryRunOutcome: "reject" }))).toBe("reject");
  });

  it("critical missing evidence → notify_only (or reject per agent)", () => {
    expect(resolveFinalExecutionMode(finalBase({ criticalMissing: true }))).toBe("notify_only");
    expect(
      resolveFinalExecutionMode(
        finalBase({ criticalMissing: true, missingEvidenceBehavior: "reject" }),
      ),
    ).toBe("reject");
  });

  it("high-risk agent never resolves above confirm (INV-4)", () => {
    expect(resolveFinalExecutionMode(finalBase({ riskLevel: "high" }))).toBe("confirm");
  });

  it("risky counterparty forces at least confirm", () => {
    expect(resolveFinalExecutionMode(finalBase({ counterpartyRisk: "sanctioned" }))).toBe(
      "confirm",
    );
    expect(resolveFinalExecutionMode(finalBase({ counterpartyRisk: "high" }))).toBe("confirm");
  });

  it("gate dry-run confirm caps at confirm", () => {
    expect(resolveFinalExecutionMode(finalBase({ gateDryRunOutcome: "confirm" }))).toBe("confirm");
  });

  it("agent default_authority caps the result", () => {
    expect(resolveFinalExecutionMode(finalBase({ agentDefaultAuthority: "propose" }))).toBe(
      "propose",
    );
    expect(resolveFinalExecutionMode(finalBase({ agentDefaultAuthority: "notify_only" }))).toBe(
      "notify_only",
    );
  });

  it("tenant authority cap applies", () => {
    expect(resolveFinalExecutionMode(finalBase({ tenantAuthorityCap: "propose" }))).toBe("propose");
  });

  it("downgrades execute to propose when confidence is below threshold", () => {
    expect(resolveFinalExecutionMode(finalBase({ confidence: 0.6 }))).toBe("propose");
  });

  it("downgrades execute to propose when evidence is incomplete", () => {
    expect(resolveFinalExecutionMode(finalBase({ evidenceComplete: false }))).toBe("propose");
  });
});
