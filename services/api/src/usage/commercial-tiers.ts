import {
  brainId,
  brainError,
  withTenantScope,
  type AuditEmitter,
  type BrainIdPrefix,
  type TenantScopedClient,
} from "@brain/shared";
import type { Pool } from "pg";

export interface CommercialTier {
  catalogRevisionId: string;
  publicTierId: string;
  revision: number;
  displayName: string;
  description: string;
  targetRateTierId: string;
  billingMode: "unpaid" | "stripe_subscription" | "stripe_invoice";
  priceMinorUnits: number | null;
  currency: string | null;
  billingInterval: "month" | "year" | null;
  priceDisplay: string;
  placeholder: boolean;
  canUpgrade: boolean;
  blockedReason: string | null;
  maximumAgents: number | null;
  maximumEntities: number | null;
  executionLimit: {
    amountMinorUnits: number;
    currency: string;
    period: "month";
    scope: "per_entity";
  } | null;
  externalAccess: {
    api: "none" | "included" | "contract";
    mcp: "none" | "included" | "contract";
  };
  includedAllowance: {
    apiUnits: number | null;
    mcpUnits: number | null;
  };
  contractSpecific: boolean;
  operatorOnly: boolean;
  limits: {
    windowSeconds: number;
    keyLimit: number;
    tenantLimit: number;
  };
}

export interface CommercialTierState {
  current: {
    rateTierId: string;
    displayName: string;
    version: number;
    status: string;
    limits: CommercialTier["limits"];
  };
  availableTiers: CommercialTier[];
}

export interface CommercialTierUpgradeResult {
  changeId: string;
  catalogRevisionId: string;
  previousRateTierId: string;
  rateTierId: string;
  entitlementVersion: number;
  effectiveAt: string;
  placeholder: boolean;
  paymentRequired: false;
}

interface CatalogRow {
  id: string;
  public_tier_id: string;
  revision: number;
  display_name: string;
  description: string;
  target_rate_tier_id: string;
  billing_mode: "unpaid" | "stripe_subscription" | "stripe_invoice";
  price_minor_units: string | number | null;
  currency: string | null;
  billing_interval: "month" | "year" | null;
  price_display: string;
  placeholder: boolean;
  public: boolean;
  self_serve_enabled: boolean;
  maximum_agents: number | null;
  maximum_entities: number | null;
  execution_limit_minor_units: string | number | null;
  execution_limit_currency: string | null;
  execution_period: "month" | null;
  execution_scope: "per_entity" | "contract" | null;
  external_api_access: "none" | "included" | "contract";
  external_mcp_access: "none" | "included" | "contract";
  included_api_units: string | number | null;
  included_mcp_units: string | number | null;
  contract_specific: boolean;
  operator_only: boolean;
  window_seconds: number;
  key_limit: number;
  tenant_limit: number;
}

interface EntitlementRow {
  tier_id: string;
  display_name: string;
  version: number;
  status: string;
  effective_at: Date | string;
  window_seconds: number;
  key_limit: number;
  tenant_limit: number;
}

export class CommercialTierService {
  public constructor(
    private readonly pool: Pool,
    private readonly audit: AuditEmitter,
  ) {}

  public async getState(tenantId: string): Promise<CommercialTierState> {
    return withTenantScope(this.pool, tenantId, async (client) => {
      const current = await getCurrentEntitlement(client, tenantId, false);
      const catalog = await listCatalog(client);
      return {
        current: serializeCurrent(current),
        availableTiers: catalog.map((tier) => serializeTier(tier, current)),
      };
    });
  }

  public async upgrade(input: {
    tenantId: string;
    actorMemberId: string;
    idempotencyKey: string;
    catalogRevisionId: string;
    expectedEntitlementVersion: number;
  }): Promise<CommercialTierUpgradeResult> {
    const durableIdempotencyKey = `self-serve-tier:${input.tenantId}:${input.idempotencyKey}`;
    const result = await withTenantScope(this.pool, input.tenantId, async (client) => {
      const existing = await client.query<{
        id: string;
        before_state: Record<string, unknown>;
        after_state: Record<string, unknown>;
      }>(
        `SELECT id, before_state, after_state
           FROM api_entitlement_change_log
          WHERE tenant_id = $1 AND idempotency_key = $2
          LIMIT 1`,
        [input.tenantId, durableIdempotencyKey],
      );
      if (existing.rows[0] !== undefined) return existingUpgrade(existing.rows[0]);

      const tier = await getCatalogRevision(client, input.catalogRevisionId);
      assertSelfServeTier(tier);
      const current = await getCurrentEntitlement(client, input.tenantId, true);
      if (current.status !== "active") {
        throw transitionDenied("tenant_entitlement_not_active");
      }
      if (current.version !== input.expectedEntitlementVersion) {
        throw transitionDenied("stale_entitlement_version");
      }
      if (!isStrictUpgrade(current, tier)) {
        throw transitionDenied("catalog_transition_not_upgrade");
      }

      const changed = await client.query<{
        tier_id: string;
        version: number;
        effective_at: Date | string;
      }>(
        `UPDATE tenant_api_entitlements
            SET tier_id = $3, version = version + 1,
                source = 'self_serve_catalog', effective_at = now(), updated_at = now()
          WHERE tenant_id = $1 AND environment = 'live' AND version = $2
          RETURNING tier_id, version, effective_at`,
        [input.tenantId, input.expectedEntitlementVersion, tier.target_rate_tier_id],
      );
      const updated = changed.rows[0];
      if (updated === undefined) throw transitionDenied("stale_entitlement_version");

      const changeId = brainId("ctchg" as BrainIdPrefix);
      const beforeState = {
        tier_id: current.tier_id,
        version: current.version,
        status: current.status,
        effective_at: toIso(current.effective_at),
      };
      const afterState = {
        tier_id: updated.tier_id,
        version: updated.version,
        status: "active",
        effective_at: toIso(updated.effective_at),
        catalog_revision_id: tier.id,
        placeholder: tier.placeholder,
        payment_required: false,
      };
      await client.query(
        `INSERT INTO api_entitlement_change_log (
           id, idempotency_key, tenant_id, environment, key_id, change_type,
           before_state, after_state, actor, reason
         ) VALUES ($1, $2, $3, 'live', NULL, 'tier_assigned',
                   $4::jsonb, $5::jsonb, $6, 'self_serve_catalog_upgrade')`,
        [
          changeId,
          durableIdempotencyKey,
          input.tenantId,
          JSON.stringify(beforeState),
          JSON.stringify(afterState),
          input.actorMemberId,
        ],
      );
      return upgradeResult(changeId, current.tier_id, tier, updated);
    });

    await this.audit.emit({
      tenantId: input.tenantId,
      layer: "identity",
      eventType: "system_activity",
      actor: input.actorMemberId,
      action: "tenant.commercial_tier.upgraded",
      inputs: {
        catalog_revision_id: input.catalogRevisionId,
        expected_entitlement_version: input.expectedEntitlementVersion,
      },
      outputs: {
        rate_tier_id: result.rateTierId,
        entitlement_version: result.entitlementVersion,
        placeholder: result.placeholder,
        payment_required: false,
      },
      outcome: "applied",
      idempotencyKey: `commercial-tier-upgrade:${result.changeId}`,
    });
    return result;
  }
}

async function listCatalog(client: TenantScopedClient): Promise<CatalogRow[]> {
  const { rows } = await client.query<CatalogRow>(
    `${CATALOG_SELECT}
      WHERE catalog.public = TRUE
        AND catalog.effective_at <= now()
        AND (catalog.retired_at IS NULL OR catalog.retired_at > now())
      ORDER BY catalog.sort_order, catalog.revision`,
  );
  return rows;
}

async function getCatalogRevision(
  client: TenantScopedClient,
  catalogRevisionId: string,
): Promise<CatalogRow> {
  const { rows } = await client.query<CatalogRow>(
    `${CATALOG_SELECT}
      WHERE catalog.id = $1
        AND catalog.effective_at <= now()
        AND (catalog.retired_at IS NULL OR catalog.retired_at > now())
      LIMIT 1`,
    [catalogRevisionId],
  );
  const row = rows[0];
  if (row === undefined) throw transitionDenied("catalog_revision_not_available");
  return row;
}

const CATALOG_SELECT = `SELECT catalog.id, catalog.public_tier_id, catalog.revision,
       catalog.display_name, catalog.description, catalog.target_rate_tier_id,
       catalog.billing_mode, catalog.price_minor_units, catalog.currency,
       catalog.billing_interval, catalog.price_display, catalog.placeholder,
       catalog.public, catalog.self_serve_enabled, catalog.maximum_agents,
       catalog.maximum_entities, catalog.execution_limit_minor_units,
       catalog.execution_limit_currency, catalog.execution_period,
       catalog.execution_scope, catalog.external_api_access,
       catalog.external_mcp_access, catalog.included_api_units,
       catalog.included_mcp_units, catalog.contract_specific,
       catalog.operator_only,
       tier.window_seconds, tier.key_limit, tier.tenant_limit
  FROM api_commercial_tier_catalog catalog
  JOIN api_rate_limit_tiers tier ON tier.id = catalog.target_rate_tier_id`;

async function getCurrentEntitlement(
  client: TenantScopedClient,
  tenantId: string,
  lock: boolean,
): Promise<EntitlementRow> {
  const { rows } = await client.query<EntitlementRow>(
    `SELECT entitlement.tier_id, tier.display_name, entitlement.version,
            entitlement.status, entitlement.effective_at,
            tier.window_seconds, tier.key_limit, tier.tenant_limit
       FROM tenant_api_entitlements entitlement
       JOIN api_rate_limit_tiers tier ON tier.id = entitlement.tier_id
      WHERE entitlement.tenant_id = $1 AND entitlement.environment = 'live'
      ${lock ? "FOR UPDATE OF entitlement" : ""}`,
    [tenantId],
  );
  const row = rows[0];
  if (row === undefined) {
    throw brainError("internal_server_error", "live tenant entitlement does not exist");
  }
  return row;
}

function serializeCurrent(row: EntitlementRow): CommercialTierState["current"] {
  return {
    rateTierId: row.tier_id,
    displayName: row.display_name,
    version: row.version,
    status: row.status,
    limits: limits(row),
  };
}

function serializeTier(row: CatalogRow, current: EntitlementRow): CommercialTier {
  const canUpgrade =
    row.public &&
    row.self_serve_enabled &&
    row.billing_mode === "unpaid" &&
    isStrictUpgrade(current, row);
  let blockedReason: string | null = null;
  if (!row.self_serve_enabled) blockedReason = "self_serve_disabled";
  else if (row.billing_mode !== "unpaid") blockedReason = "payment_required";
  else if (row.target_rate_tier_id === current.tier_id) blockedReason = "current_tier";
  else if (!isStrictUpgrade(current, row)) blockedReason = "not_an_upgrade";
  return {
    catalogRevisionId: row.id,
    publicTierId: row.public_tier_id,
    revision: row.revision,
    displayName: row.display_name,
    description: row.description,
    targetRateTierId: row.target_rate_tier_id,
    billingMode: row.billing_mode,
    priceMinorUnits: row.price_minor_units === null ? null : Number(row.price_minor_units),
    currency: row.currency,
    billingInterval: row.billing_interval,
    priceDisplay: row.price_display,
    placeholder: row.placeholder,
    canUpgrade,
    blockedReason,
    maximumAgents: row.maximum_agents,
    maximumEntities: row.maximum_entities,
    executionLimit:
      row.execution_limit_minor_units === null ||
      row.execution_limit_currency === null ||
      row.execution_period !== "month" ||
      row.execution_scope !== "per_entity"
        ? null
        : {
            amountMinorUnits: Number(row.execution_limit_minor_units),
            currency: row.execution_limit_currency,
            period: row.execution_period,
            scope: row.execution_scope,
          },
    externalAccess: {
      api: row.external_api_access,
      mcp: row.external_mcp_access,
    },
    includedAllowance: {
      apiUnits: row.included_api_units === null ? null : Number(row.included_api_units),
      mcpUnits: row.included_mcp_units === null ? null : Number(row.included_mcp_units),
    },
    contractSpecific: row.contract_specific,
    operatorOnly: row.operator_only,
    limits: limits(row),
  };
}

function assertSelfServeTier(tier: CatalogRow): void {
  if (!tier.public || !tier.self_serve_enabled) {
    throw transitionDenied("catalog_revision_not_self_serve");
  }
  if (tier.billing_mode !== "unpaid") {
    throw transitionDenied("payment_required");
  }
}

function isStrictUpgrade(current: EntitlementRow, target: CatalogRow): boolean {
  const noLowerLimit =
    target.key_limit >= current.key_limit && target.tenant_limit >= current.tenant_limit;
  const raisesLimit =
    target.key_limit > current.key_limit || target.tenant_limit > current.tenant_limit;
  return noLowerLimit && raisesLimit;
}

function limits(row: {
  window_seconds: number;
  key_limit: number;
  tenant_limit: number;
}): CommercialTier["limits"] {
  return {
    windowSeconds: row.window_seconds,
    keyLimit: row.key_limit,
    tenantLimit: row.tenant_limit,
  };
}

function transitionDenied(reason: string) {
  return brainError("tenant_access_denied", "commercial tier transition is not available", {
    statusOverride: 409,
    details: { reason },
  });
}

function upgradeResult(
  changeId: string,
  previousRateTierId: string,
  tier: CatalogRow,
  updated: { tier_id: string; version: number; effective_at: Date | string },
): CommercialTierUpgradeResult {
  return {
    changeId,
    catalogRevisionId: tier.id,
    previousRateTierId,
    rateTierId: updated.tier_id,
    entitlementVersion: updated.version,
    effectiveAt: toIso(updated.effective_at),
    placeholder: tier.placeholder,
    paymentRequired: false,
  };
}

function existingUpgrade(row: {
  id: string;
  before_state: Record<string, unknown>;
  after_state: Record<string, unknown>;
}): CommercialTierUpgradeResult {
  const beforeTier = row.before_state["tier_id"];
  const rateTier = row.after_state["tier_id"];
  const version = row.after_state["version"];
  const effectiveAt = row.after_state["effective_at"];
  const catalogRevisionId = row.after_state["catalog_revision_id"];
  if (
    typeof beforeTier !== "string" ||
    typeof rateTier !== "string" ||
    typeof version !== "number" ||
    typeof effectiveAt !== "string" ||
    typeof catalogRevisionId !== "string"
  ) {
    throw brainError("internal_server_error", "stored commercial tier change is malformed");
  }
  return {
    changeId: row.id,
    catalogRevisionId,
    previousRateTierId: beforeTier,
    rateTierId: rateTier,
    entitlementVersion: version,
    effectiveAt,
    placeholder: row.after_state["placeholder"] === true,
    paymentRequired: false,
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
