import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { brainError, requireAdminMember, requireScope } from "@brain/shared";
import type {
  CommercialTierService,
  CommercialTierState,
  CommercialTierUpgradeResult,
} from "./commercial-tiers.js";

export interface CommercialTierRoutesDeps {
  pool: Pool;
  service: Pick<CommercialTierService, "getState" | "upgrade">;
}

export async function registerCommercialTierRoutes(
  app: FastifyInstance,
  deps: CommercialTierRoutesDeps,
): Promise<void> {
  app.get<{ Params: { tenantId: string } }>("/tenants/:tenantId/billing/tiers", async (request) => {
    await requireTierAdmin(request, deps.pool, request.params.tenantId);
    return serializeState(await deps.service.getState(request.params.tenantId));
  });

  app.post<{
    Params: { tenantId: string };
    Body?: { catalog_revision_id?: unknown; expected_entitlement_version?: unknown };
  }>("/tenants/:tenantId/billing/tier-upgrade", async (request, reply) => {
    const principal = await requireTierAdmin(request, deps.pool, request.params.tenantId);
    const catalogRevisionId = requiredString(
      request.body?.catalog_revision_id,
      "catalog_revision_id",
    );
    const expectedEntitlementVersion = positiveInteger(
      request.body?.expected_entitlement_version,
      "expected_entitlement_version",
    );
    const result = await deps.service.upgrade({
      tenantId: request.params.tenantId,
      actorMemberId: principal.id,
      idempotencyKey: requireIdempotencyKey(request.headers["idempotency-key"]),
      catalogRevisionId,
      expectedEntitlementVersion,
    });
    reply.status(201);
    return serializeUpgrade(result);
  });
}

async function requireTierAdmin(request: FastifyRequest, pool: Pool, tenantId: string) {
  const principal = request.principal;
  if (principal === undefined) throw brainError("auth_token_missing", "principal required");
  if (principal.type !== "user") {
    throw brainError("auth_scope_insufficient", "tier changes require principal_type=user");
  }
  if (principal.tenantId !== tenantId) {
    throw brainError("auth_tenant_mismatch", "commercial tiers are tenant self-service only");
  }
  requireScope(principal.scopes, "execution:admin");
  await requireAdminMember(pool, tenantId, principal.id);
  return principal;
}

function requireIdempotencyKey(value: string | string[] | undefined): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (candidate === undefined || candidate.trim().length === 0 || candidate.length > 256) {
    throw brainError("request_body_invalid", "Idempotency-Key header is required");
  }
  return candidate;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 128) {
    throw brainError("request_body_invalid", `${field} is required`);
  }
  return value.trim();
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw brainError("request_body_invalid", `${field} must be a positive integer`);
  }
  return value;
}

function serializeState(state: CommercialTierState) {
  return {
    current: {
      rate_tier_id: state.current.rateTierId,
      display_name: state.current.displayName,
      version: state.current.version,
      status: state.current.status,
      limits: serializeLimits(state.current.limits),
    },
    available_tiers: state.availableTiers.map((tier) => ({
      catalog_revision_id: tier.catalogRevisionId,
      public_tier_id: tier.publicTierId,
      revision: tier.revision,
      display_name: tier.displayName,
      description: tier.description,
      target_rate_tier_id: tier.targetRateTierId,
      billing_mode: tier.billingMode,
      price_minor_units: tier.priceMinorUnits,
      currency: tier.currency,
      billing_interval: tier.billingInterval,
      price_display: tier.priceDisplay,
      placeholder: tier.placeholder,
      can_upgrade: tier.canUpgrade,
      blocked_reason: tier.blockedReason,
      maximum_agents: tier.maximumAgents,
      maximum_entities: tier.maximumEntities,
      execution_limit:
        tier.executionLimit === null
          ? null
          : {
              amount_minor_units: tier.executionLimit.amountMinorUnits,
              currency: tier.executionLimit.currency,
              period: tier.executionLimit.period,
              scope: tier.executionLimit.scope,
            },
      external_access: tier.externalAccess,
      included_allowance: {
        api_units: tier.includedAllowance.apiUnits,
        mcp_units: tier.includedAllowance.mcpUnits,
      },
      contract_specific: tier.contractSpecific,
      operator_only: tier.operatorOnly,
      limits: serializeLimits(tier.limits),
    })),
  };
}

function serializeUpgrade(result: CommercialTierUpgradeResult) {
  return {
    change_id: result.changeId,
    catalog_revision_id: result.catalogRevisionId,
    previous_rate_tier_id: result.previousRateTierId,
    rate_tier_id: result.rateTierId,
    entitlement_version: result.entitlementVersion,
    effective_at: result.effectiveAt,
    placeholder: result.placeholder,
    payment_required: result.paymentRequired,
  };
}

function serializeLimits(limits: { windowSeconds: number; keyLimit: number; tenantLimit: number }) {
  return {
    window_seconds: limits.windowSeconds,
    key_limit: limits.keyLimit,
    tenant_limit: limits.tenantLimit,
  };
}
