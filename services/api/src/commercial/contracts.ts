/**
 * Accepted commercial control-plane contracts for RFC 0009, RFC 0011, and
 * RFC 0012. Phase 1 defines types only. It provides no Stripe, Coinbase,
 * wallet, or execution implementation.
 */

export const COMMERCIAL_FEATURE_NAMES = [
  "catalog",
  "entity_scope",
  "agent_capacity",
  "execution_limits",
  "stripe_billing",
  "x402_payments",
  "outcome_fees",
  "movement_fees",
] as const;

export type CommercialFeatureName = (typeof COMMERCIAL_FEATURE_NAMES)[number];
export type CommercialFeatureMode = "disabled" | "shadow" | "enforced";
export type CommercialTierId = "free" | "starter" | "growth" | "scale" | "enterprise";
export type UsageOperationClass = "api" | "mcp";

export interface CommercialFeatureFlags {
  readonly catalog: boolean;
  readonly entityScope: boolean;
  readonly agentCapacity: boolean;
  readonly executionLimits: boolean;
  readonly stripeBilling: boolean;
  readonly x402Payments: boolean;
  readonly outcomeFees: boolean;
  readonly movementFees: boolean;
}

export const PHASE_ONE_COMMERCIAL_FEATURE_FLAGS: CommercialFeatureFlags = Object.freeze({
  catalog: false,
  entityScope: false,
  agentCapacity: false,
  executionLimits: false,
  stripeBilling: false,
  x402Payments: false,
  outcomeFees: false,
  movementFees: false,
});

export interface CommercialCatalogRevision {
  readonly id: string;
  readonly publicTierId: CommercialTierId;
  readonly revision: number;
  readonly brand: "RobotMoney";
  readonly maximumAgents: number | null;
  readonly maximumEntities: number | null;
  readonly executionLimit: MoneyLimit | null;
  readonly externalApiAccess: "none" | "included" | "contract";
  readonly externalMcpAccess: "none" | "included" | "contract";
  readonly includedApiUnits: number | null;
  readonly includedMcpUnits: number | null;
  readonly contractSpecific: boolean;
  readonly public: boolean;
  readonly selfServeEnabled: boolean;
  readonly operatorOnly: boolean;
}

export interface MoneyLimit {
  readonly amountMinorUnits: bigint;
  readonly currency: "USD";
  readonly period: "month";
  readonly scope: "per_entity";
}

export interface RobotMoneyEntityContract {
  readonly id: string;
  readonly tenantId: string;
  readonly state: "draft" | "active" | "capacity_paused" | "deactivated";
  readonly commercialCapRevisionId: string;
  readonly version: number;
}

export interface CommercialAgentInstanceContract {
  readonly id: string;
  readonly tenantId: string;
  readonly entityId: string;
  readonly runtimeAgentId: string | null;
  readonly lifecycleState: "draft" | "active" | "capacity_paused" | "deleted";
  readonly systemBootstrap: boolean;
  readonly demoInstance: boolean;
  readonly version: number;
}

export function countsTowardAgentCapacity(agent: CommercialAgentInstanceContract): boolean {
  return agent.lifecycleState === "active" && !agent.systemBootstrap && !agent.demoInstance;
}

export interface TenantCommercialEntitlementContract {
  readonly tenantId: string;
  readonly catalogRevisionId: string;
  readonly priceRevisionId: string | null;
  readonly billingAccountId: string | null;
  readonly lifecycleStatus: "active" | "restricted" | "canceling" | "canceled";
  readonly accessStatus: "active" | "restricted";
  readonly version: number;
  readonly effectiveAt: string;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
}

export interface UsageAllowanceReservationContract {
  readonly id: string;
  readonly tenantId: string;
  readonly operationClass: UsageOperationClass;
  readonly logicalOperationId: string;
  readonly units: bigint;
  readonly status: "reserved" | "consumed" | "released" | "expired";
  readonly expiresAt: string;
}

export interface ExecutionLimitReservationContract {
  readonly id: string;
  readonly tenantId: string;
  readonly entityId: string;
  readonly logicalMovementId: string;
  readonly sourceAmountMinorUnits: bigint;
  readonly sourceCurrency: string;
  readonly referenceRate: string;
  readonly referenceRateAt: string;
  readonly usdEquivalentMinorUnits: bigint;
  readonly status: "reserved" | "settled" | "released" | "partially_reversed" | "reversed";
}

export interface CommercialProviderCommand {
  readonly id: string;
  readonly tenantId: string | null;
  readonly billingAccountId: string | null;
  readonly provider: "stripe" | "coinbase_cdp" | "base";
  readonly providerMode: "test" | "live";
  readonly commandType: string;
  readonly idempotencyKey: string;
  readonly requestEnvelope: Readonly<Record<string, unknown>>;
}

export interface CommercialProviderCommandResult {
  readonly providerReference: string;
  readonly responseEnvelope: Readonly<Record<string, unknown>>;
}

/** Provider implementations arrive in later phases and remain absent here. */
export interface StripeBillingPort {
  dispatch(command: CommercialProviderCommand): Promise<CommercialProviderCommandResult>;
}

export interface X402PaymentRequirements {
  readonly scheme: "exact";
  readonly network: "eip155:8453" | "eip155:84532";
  readonly amountAtomic: bigint;
  readonly assetContract: string;
  readonly recipientAddress: string;
  readonly quoteExpiresAt: string;
  readonly resource: string;
}

export interface X402VerificationResult {
  readonly accepted: boolean;
  readonly reason: string | null;
  readonly payerAddress: string | null;
}

export interface X402SettlementResult {
  readonly transactionHash: string;
  readonly network: string;
  readonly settledAt: string;
}

/** Coinbase CDP integration is supplied only after the Sepolia sandbox phase. */
export interface X402FacilitatorPort {
  verify(input: {
    readonly requirements: X402PaymentRequirements;
    readonly paymentPayload: string;
  }): Promise<X402VerificationResult>;

  settle(input: {
    readonly logicalOperationId: string;
    readonly requirements: X402PaymentRequirements;
    readonly paymentPayload: string;
  }): Promise<X402SettlementResult>;
}

export interface BaseFinalityPort {
  readFinality(transactionHash: string): Promise<"not_found" | "sealed" | "l1_included">;
}
