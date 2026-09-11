import { describe, expect, it } from "vitest";
import { evaluateCommercialShadow, qualifiesForCommercialShadowReview } from "./shadow.js";

const scale = {
  catalogRevisionId: "robotmoney_scale_v1",
  maximumEntities: 10,
  maximumAgents: 11,
  executionLimitMinorUnits: 250_000_000n,
  includedApiUnits: 250_000n,
  includedMcpUnits: 25_000n,
};

describe("commercial Phase 2 shadow evaluation", () => {
  it("records within-limit outcomes without applying enforcement", () => {
    expect(
      evaluateCommercialShadow({
        catalog: scale,
        entityCount: 10,
        countedAgentCount: 11,
        executionSettledMinorUnits: 249_000_000n,
        executionReservedMinorUnits: 1_000_000n,
        executionEvidenceComplete: true,
        apiUnits: 250_000n,
        mcpUnits: 25_000n,
        apiEvidenceComplete: true,
        mcpEvidenceComplete: true,
      }),
    ).toEqual({
      catalogRevisionId: "robotmoney_scale_v1",
      catalogResolution: "explicit",
      entityCapacityResult: "within",
      agentCapacityResult: "within",
      executionLimitResult: "within",
      apiUnitResult: "within",
      mcpUnitResult: "within",
      divergenceCodes: [],
      enforcementApplied: false,
    });
  });

  it("reports every counterfactual overage without denying the action", () => {
    const result = evaluateCommercialShadow({
      catalog: scale,
      entityCount: 11,
      countedAgentCount: 12,
      executionSettledMinorUnits: 250_000_000n,
      executionReservedMinorUnits: 1n,
      executionEvidenceComplete: true,
      apiUnits: 250_001n,
      mcpUnits: 25_001n,
      apiEvidenceComplete: true,
      mcpEvidenceComplete: true,
    });
    expect(result.divergenceCodes).toEqual([
      "entity_capacity_exceeded",
      "agent_capacity_exceeded",
      "execution_limit_exceeded",
      "api_unit_allowance_exceeded",
      "mcp_unit_allowance_exceeded",
    ]);
    expect(result.enforcementApplied).toBe(false);
  });

  it("does not infer a commercial tier from a legacy rate-limit tier", () => {
    expect(
      evaluateCommercialShadow({
        catalog: null,
        entityCount: 1,
        countedAgentCount: 1,
        executionSettledMinorUnits: 0n,
        executionReservedMinorUnits: 0n,
        executionEvidenceComplete: true,
        apiUnits: 0n,
        mcpUnits: 0n,
        apiEvidenceComplete: true,
        mcpEvidenceComplete: true,
      }),
    ).toMatchObject({
      catalogResolution: "unresolved",
      divergenceCodes: ["catalog_revision_unresolved"],
    });
  });

  it("fails the execution dimension open when currency evidence is incomplete", () => {
    expect(
      evaluateCommercialShadow({
        catalog: scale,
        entityCount: 1,
        countedAgentCount: 1,
        executionSettledMinorUnits: 0n,
        executionReservedMinorUnits: 0n,
        executionEvidenceComplete: false,
        apiUnits: 1n,
        mcpUnits: 1n,
        apiEvidenceComplete: true,
        mcpEvidenceComplete: true,
      }),
    ).toMatchObject({
      executionLimitResult: "unresolved",
      divergenceCodes: ["execution_evidence_incomplete"],
      enforcementApplied: false,
    });
  });

  it("marks API and MCP units unresolved when reconciliation evidence is incomplete", () => {
    expect(
      evaluateCommercialShadow({
        catalog: scale,
        entityCount: 1,
        countedAgentCount: 1,
        executionSettledMinorUnits: 0n,
        executionReservedMinorUnits: 0n,
        executionEvidenceComplete: true,
        apiUnits: 100n,
        mcpUnits: 10n,
        apiEvidenceComplete: false,
        mcpEvidenceComplete: false,
      }),
    ).toMatchObject({
      apiUnitResult: "unresolved",
      mcpUnitResult: "unresolved",
      divergenceCodes: ["api_usage_evidence_incomplete", "mcp_usage_evidence_incomplete"],
      enforcementApplied: false,
    });
  });

  it("requires a full 30-day observation window before review", () => {
    const startedAt = new Date("2026-09-03T00:00:00Z");
    expect(
      qualifiesForCommercialShadowReview({
        startedAt,
        now: new Date("2026-10-02T23:59:59.999Z"),
      }),
    ).toBe(false);
    expect(
      qualifiesForCommercialShadowReview({
        startedAt,
        now: new Date("2026-10-03T00:00:00Z"),
      }),
    ).toBe(true);
  });
});
