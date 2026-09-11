export type CommercialShadowLimitResult = "within" | "over" | "unresolved";

export interface CommercialShadowCatalogLimits {
  readonly catalogRevisionId: string;
  readonly maximumEntities: number | null;
  readonly maximumAgents: number | null;
  readonly executionLimitMinorUnits: bigint | null;
  readonly includedApiUnits: bigint | null;
  readonly includedMcpUnits: bigint | null;
}

export interface CommercialShadowInput {
  readonly catalog: CommercialShadowCatalogLimits | null;
  readonly entityCount: number;
  readonly countedAgentCount: number;
  readonly executionSettledMinorUnits: bigint;
  readonly executionReservedMinorUnits: bigint;
  readonly executionEvidenceComplete: boolean;
  readonly apiUnits: bigint;
  readonly mcpUnits: bigint;
  readonly apiEvidenceComplete: boolean;
  readonly mcpEvidenceComplete: boolean;
}

export interface CommercialShadowResult {
  readonly catalogRevisionId: string | null;
  readonly catalogResolution: "explicit" | "unresolved";
  readonly entityCapacityResult: CommercialShadowLimitResult;
  readonly agentCapacityResult: CommercialShadowLimitResult;
  readonly executionLimitResult: CommercialShadowLimitResult;
  readonly apiUnitResult: CommercialShadowLimitResult;
  readonly mcpUnitResult: CommercialShadowLimitResult;
  readonly divergenceCodes: readonly string[];
  readonly enforcementApplied: false;
}

export function evaluateCommercialShadow(input: CommercialShadowInput): CommercialShadowResult {
  assertNonNegativeInteger(input.entityCount, "entityCount");
  assertNonNegativeInteger(input.countedAgentCount, "countedAgentCount");
  assertNonNegativeBigInt(input.executionSettledMinorUnits, "executionSettledMinorUnits");
  assertNonNegativeBigInt(input.executionReservedMinorUnits, "executionReservedMinorUnits");
  assertNonNegativeBigInt(input.apiUnits, "apiUnits");
  assertNonNegativeBigInt(input.mcpUnits, "mcpUnits");

  if (input.catalog === null) {
    return {
      catalogRevisionId: null,
      catalogResolution: "unresolved",
      entityCapacityResult: "unresolved",
      agentCapacityResult: "unresolved",
      executionLimitResult: "unresolved",
      apiUnitResult: "unresolved",
      mcpUnitResult: "unresolved",
      divergenceCodes: ["catalog_revision_unresolved"],
      enforcementApplied: false,
    };
  }

  const entityCapacityResult = compareCount(input.entityCount, input.catalog.maximumEntities);
  const agentCapacityResult = compareCount(input.countedAgentCount, input.catalog.maximumAgents);
  const executionLimitResult = input.executionEvidenceComplete
    ? compareAmount(
        input.executionSettledMinorUnits + input.executionReservedMinorUnits,
        input.catalog.executionLimitMinorUnits,
      )
    : "unresolved";
  const apiUnitResult = input.apiEvidenceComplete
    ? compareUsage(input.apiUnits, input.catalog.includedApiUnits)
    : "unresolved";
  const mcpUnitResult = input.mcpEvidenceComplete
    ? compareUsage(input.mcpUnits, input.catalog.includedMcpUnits)
    : "unresolved";
  const divergenceCodes: string[] = [];
  if (entityCapacityResult === "over") divergenceCodes.push("entity_capacity_exceeded");
  if (agentCapacityResult === "over") divergenceCodes.push("agent_capacity_exceeded");
  if (!input.executionEvidenceComplete) {
    divergenceCodes.push("execution_evidence_incomplete");
  } else if (executionLimitResult === "over") {
    divergenceCodes.push("execution_limit_exceeded");
  }
  if (!input.apiEvidenceComplete) {
    divergenceCodes.push("api_usage_evidence_incomplete");
  } else if (apiUnitResult === "unresolved") {
    divergenceCodes.push("api_unit_allowance_unresolved");
  } else if (apiUnitResult === "over") {
    divergenceCodes.push("api_unit_allowance_exceeded");
  }
  if (!input.mcpEvidenceComplete) {
    divergenceCodes.push("mcp_usage_evidence_incomplete");
  } else if (mcpUnitResult === "unresolved") {
    divergenceCodes.push("mcp_unit_allowance_unresolved");
  } else if (mcpUnitResult === "over") {
    divergenceCodes.push("mcp_unit_allowance_exceeded");
  }

  return {
    catalogRevisionId: input.catalog.catalogRevisionId,
    catalogResolution: "explicit",
    entityCapacityResult,
    agentCapacityResult,
    executionLimitResult,
    apiUnitResult,
    mcpUnitResult,
    divergenceCodes,
    enforcementApplied: false,
  };
}

export function qualifiesForCommercialShadowReview(input: {
  readonly startedAt: Date;
  readonly now: Date;
  readonly minimumDays?: number;
}): boolean {
  const minimumDays = input.minimumDays ?? 30;
  if (!Number.isInteger(minimumDays) || minimumDays < 30) {
    throw new RangeError("minimumDays must be an integer of at least 30");
  }
  return input.now.getTime() - input.startedAt.getTime() >= minimumDays * 86_400_000;
}

function compareCount(value: number, limit: number | null): CommercialShadowLimitResult {
  if (limit === null) return "within";
  return value > limit ? "over" : "within";
}

function compareAmount(value: bigint, limit: bigint | null): CommercialShadowLimitResult {
  if (limit === null) return "within";
  return value > limit ? "over" : "within";
}

function compareUsage(value: bigint, allowance: bigint | null): CommercialShadowLimitResult {
  if (allowance === null) return "unresolved";
  return value > allowance ? "over" : "within";
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`${label} must be non-negative`);
}

function assertNonNegativeBigInt(value: bigint, label: string): void {
  if (value < 0n) throw new RangeError(`${label} must be non-negative`);
}
