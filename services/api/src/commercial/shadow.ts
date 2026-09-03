export type CommercialShadowLimitResult = "within" | "over" | "unresolved";

export interface CommercialShadowCatalogLimits {
  readonly catalogRevisionId: string;
  readonly maximumEntities: number | null;
  readonly maximumAgents: number | null;
  readonly executionLimitMinorUnits: bigint | null;
}

export interface CommercialShadowInput {
  readonly catalog: CommercialShadowCatalogLimits | null;
  readonly entityCount: number;
  readonly countedAgentCount: number;
  readonly executionSettledMinorUnits: bigint;
  readonly executionReservedMinorUnits: bigint;
  readonly executionEvidenceComplete: boolean;
}

export interface CommercialShadowResult {
  readonly catalogRevisionId: string | null;
  readonly catalogResolution: "explicit" | "unresolved";
  readonly entityCapacityResult: CommercialShadowLimitResult;
  readonly agentCapacityResult: CommercialShadowLimitResult;
  readonly executionLimitResult: CommercialShadowLimitResult;
  readonly divergenceCodes: readonly string[];
  readonly enforcementApplied: false;
}

export function evaluateCommercialShadow(input: CommercialShadowInput): CommercialShadowResult {
  assertNonNegativeInteger(input.entityCount, "entityCount");
  assertNonNegativeInteger(input.countedAgentCount, "countedAgentCount");
  assertNonNegativeBigInt(input.executionSettledMinorUnits, "executionSettledMinorUnits");
  assertNonNegativeBigInt(input.executionReservedMinorUnits, "executionReservedMinorUnits");

  if (input.catalog === null) {
    return {
      catalogRevisionId: null,
      catalogResolution: "unresolved",
      entityCapacityResult: "unresolved",
      agentCapacityResult: "unresolved",
      executionLimitResult: "unresolved",
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
  const divergenceCodes: string[] = [];
  if (entityCapacityResult === "over") divergenceCodes.push("entity_capacity_exceeded");
  if (agentCapacityResult === "over") divergenceCodes.push("agent_capacity_exceeded");
  if (!input.executionEvidenceComplete) {
    divergenceCodes.push("execution_evidence_incomplete");
  } else if (executionLimitResult === "over") {
    divergenceCodes.push("execution_limit_exceeded");
  }

  return {
    catalogRevisionId: input.catalog.catalogRevisionId,
    catalogResolution: "explicit",
    entityCapacityResult,
    agentCapacityResult,
    executionLimitResult,
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

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`${label} must be non-negative`);
}

function assertNonNegativeBigInt(value: bigint, label: string): void {
  if (value < 0n) throw new RangeError(`${label} must be non-negative`);
}
