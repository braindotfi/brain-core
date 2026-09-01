import type { Principal } from "./principal.js";
import type { Scope } from "./scopes.js";
import type { ApiRateLimitDecision, ApiRateLimitPolicy } from "../ratelimit/sliding-window.js";

export type ApiKeyEnvironment = "sandbox" | "live";
export type ApiKeyAccessStage = "demo" | "production_review" | "production" | null;
export type ApiKeyProductFamily = "ledger" | "raw" | "audit" | "governance";

export interface ApiKeyRouteMeteringContract {
  readonly operationId: string;
  readonly requiredScope: Scope;
  readonly productFamily: ApiKeyProductFamily;
  readonly metered: true;
}

export interface ApiKeyRouteContract extends ApiKeyRouteMeteringContract {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly route: string;
}

export interface ApiKeyAttribution {
  readonly keyId: string;
  readonly tenantId: string;
  readonly environment: ApiKeyEnvironment;
  readonly accessStage: ApiKeyAccessStage;
}

export type ApiKeyKnownRejectionReason =
  | "revoked"
  | "expired"
  | "tenant_ineligible"
  | "rate_limited"
  | "rate_limiter_unavailable";

export type ApiKeyUnknownRejectionReason = "malformed" | "unknown" | "authenticator_disabled";

export type ApiKeyAuthenticationResult =
  | {
      readonly kind: "authenticated";
      readonly principal: Principal;
      readonly attribution: ApiKeyAttribution;
      /** Compatibility alias for callers that previously consumed keyId directly. */
      readonly keyId: string;
      readonly rateLimit?: ApiRateLimitDecision;
      readonly rateLimitPolicy?: ApiRateLimitPolicy;
    }
  | {
      readonly kind: "known_rejected";
      readonly attribution: ApiKeyAttribution;
      readonly reason: ApiKeyKnownRejectionReason;
      readonly rateLimit?: ApiRateLimitDecision;
      readonly rateLimitPolicy?: ApiRateLimitPolicy;
    }
  | {
      readonly kind: "unknown_rejected";
      readonly reason: ApiKeyUnknownRejectionReason;
    };

export type ApiRequestMeterOutcome =
  | "success"
  | "client_error"
  | "server_error"
  | "scope_rejected"
  | "auth_rejected"
  | "rate_limited";

export interface ApiRequestMeterEvent {
  readonly requestId: string;
  readonly tenantId: string;
  readonly keyId: string;
  readonly occurredAt: Date;
  readonly environment: ApiKeyEnvironment;
  readonly accessStage: ApiKeyAccessStage;
  readonly method: string;
  readonly routeTemplate: string;
  readonly operationId: string;
  readonly requiredScope: Scope | null;
  readonly productFamily: ApiKeyProductFamily | null;
  readonly statusCode: number;
  readonly outcome: ApiRequestMeterOutcome;
  readonly rejectionReason: string | null;
  readonly rateLimitCount: number | null;
  readonly rateLimitValue: number | null;
  readonly rateLimitWindowSeconds: number | null;
  readonly effectiveTierId: string | null;
  readonly entitlementVersion: number | null;
  readonly rateLimitTenantCount: number | null;
  readonly rateLimitTenantValue: number | null;
  readonly rateLimitRejectedBy: "key" | "tenant" | "key_and_tenant" | null;
  readonly meteringPolicyVersion?: string;
  readonly billableUnits?: number;
}

export interface ApiRequestMeter {
  record(event: ApiRequestMeterEvent): Promise<void>;
}

export interface ApiKeySecurityTelemetryEvent {
  readonly requestId: string;
  readonly method: string;
  readonly routeTemplate: string;
  readonly reason: "missing_bearer" | ApiKeyUnknownRejectionReason;
}

export interface ApiKeySecurityTelemetry {
  record(event: ApiKeySecurityTelemetryEvent): void;
}

export interface ApiKeyMeterFailureTelemetryEvent {
  readonly requestId: string;
  readonly tenantId: string;
  readonly keyId: string;
  readonly environment: ApiKeyEnvironment;
}

export interface ApiKeyMeterFailureTelemetry {
  record(event: ApiKeyMeterFailureTelemetryEvent): void;
}

export interface ApiKeyGatewayTelemetryEvent {
  readonly requestId: string;
  readonly tenantId: string;
  readonly keyId: string;
  readonly environment: ApiKeyEnvironment;
  readonly limiterDecision: boolean;
}

export interface ApiKeyGatewayTelemetry {
  record(event: ApiKeyGatewayTelemetryEvent): void;
}

export function routeContractKey(method: string, route: string): string {
  return `${method.toUpperCase()} ${normalizeRouteTemplate(route)}`;
}

export function normalizeRouteTemplate(route: string): string {
  return route.replace(/\{([^}]+)\}/g, ":$1");
}

export function validateApiKeyRouteContracts(
  contracts: readonly ApiKeyRouteContract[],
): ReadonlyMap<string, ApiKeyRouteMeteringContract> {
  const indexed = new Map<string, ApiKeyRouteMeteringContract>();
  const operationIds = new Set<string>();
  for (const contract of contracts) {
    const key = routeContractKey(contract.method, contract.route);
    if (indexed.has(key)) {
      throw new Error(`duplicate API key route metering contract: ${key}`);
    }
    if (operationIds.has(contract.operationId)) {
      throw new Error(`duplicate API key operation id: ${contract.operationId}`);
    }
    if (contract.operationId.trim().length === 0) {
      throw new Error(`empty API key operation id: ${key}`);
    }
    indexed.set(key, {
      operationId: contract.operationId,
      requiredScope: contract.requiredScope,
      productFamily: contract.productFamily,
      metered: true,
    });
    operationIds.add(contract.operationId);
  }
  return indexed;
}
