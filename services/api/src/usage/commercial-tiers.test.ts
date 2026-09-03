import { describe, expect, it } from "vitest";
import { InMemoryAuditEmitter } from "@brain/shared";
import { CommercialTierService } from "./commercial-tiers.js";

const tenantId = "tnt_01K123456789ABCDEFGHJKMNPQ";

describe("CommercialTierService", () => {
  it("lists accepted revisions with self-serve activation disabled", async () => {
    const { pool } = fakePool();
    const state = await new CommercialTierService(pool, new InMemoryAuditEmitter()).getState(
      tenantId,
    );

    expect(state.current).toMatchObject({ rateTierId: "starter_v1", version: 1 });
    expect(state.availableTiers).toEqual([
      expect.objectContaining({
        catalogRevisionId: "robotmoney_free_v1",
        placeholder: false,
        canUpgrade: false,
        blockedReason: "self_serve_disabled",
      }),
      expect.objectContaining({
        catalogRevisionId: "robotmoney_growth_v1",
        priceDisplay: "$499 per month",
        placeholder: false,
        canUpgrade: false,
        blockedReason: "self_serve_disabled",
        maximumAgents: 5,
        maximumEntities: 1,
        includedAllowance: { apiUnits: 25000, mcpUnits: 2500 },
      }),
    ]);
  });

  it("lets an admin service apply an unpaid catalog upgrade with CAS and audit evidence", async () => {
    const { pool, queries } = fakePool({
      billingMode: "unpaid",
      selfServeEnabled: true,
    });
    const audit = new InMemoryAuditEmitter();
    const result = await new CommercialTierService(pool, audit).upgrade({
      tenantId,
      actorMemberId: "user_admin",
      idempotencyKey: "tier-upgrade-1",
      catalogRevisionId: "foundation_unpaid_growth_v1",
      expectedEntitlementVersion: 1,
    });

    expect(result).toMatchObject({
      catalogRevisionId: "foundation_unpaid_growth_v1",
      previousRateTierId: "starter_v1",
      rateTierId: "standard_v1",
      entitlementVersion: 2,
      placeholder: false,
      paymentRequired: false,
    });
    expect(
      queries.some(
        ({ sql, values }) =>
          sql.includes("UPDATE tenant_api_entitlements") &&
          values.includes(1) &&
          values.includes("standard_v1"),
      ),
    ).toBe(true);
    expect(audit.events[0]).toMatchObject({
      action: "tenant.commercial_tier.upgraded",
      actor: "user_admin",
      outputs: { placeholder: false, payment_required: false },
    });
  });

  it("leaves Stripe-backed revisions blocked until RFC 0009 supplies paid state", async () => {
    const { pool } = fakePool({
      billingMode: "stripe_subscription",
      selfServeEnabled: true,
    });
    await expect(
      new CommercialTierService(pool, new InMemoryAuditEmitter()).upgrade({
        tenantId,
        actorMemberId: "user_admin",
        idempotencyKey: "tier-upgrade-paid",
        catalogRevisionId: "robotmoney_growth_v1",
        expectedEntitlementVersion: 1,
      }),
    ).rejects.toMatchObject({
      code: "tenant_access_denied",
      details: { reason: "payment_required" },
    });
  });
});

function fakePool(
  options: {
    billingMode?: "unpaid" | "stripe_subscription";
    selfServeEnabled?: boolean;
  } = {},
) {
  const queries: Array<{ sql: string; values: readonly unknown[] }> = [];
  const current = {
    tier_id: "starter_v1",
    display_name: "Starter",
    version: 1,
    status: "active",
    effective_at: "2026-09-02T00:00:00.000Z",
    window_seconds: 60,
    key_limit: 60,
    tenant_limit: 600,
  };
  const starter = catalogRow({
    id: "robotmoney_free_v1",
    public_tier_id: "free",
    target_rate_tier_id: "starter_v1",
    display_name: "Free",
    self_serve_enabled: false,
    key_limit: 60,
    tenant_limit: 600,
  });
  const growth = catalogRow({
    id: options.billingMode === "unpaid" ? "foundation_unpaid_growth_v1" : "robotmoney_growth_v1",
    public_tier_id: "growth",
    target_rate_tier_id: "standard_v1",
    display_name: "Growth",
    key_limit: 300,
    tenant_limit: 3000,
    billing_mode: options.billingMode ?? "stripe_subscription",
    price_minor_units: 49900,
    currency: "USD",
    billing_interval: "month",
    price_display: "$499 per month",
    self_serve_enabled: options.selfServeEnabled ?? false,
    maximum_agents: 5,
    maximum_entities: 1,
    execution_limit_minor_units: 25000000,
    external_api_access: "included",
    external_mcp_access: "included",
    included_api_units: 25000,
    included_mcp_units: 2500,
  });
  const client = {
    query: async (sql: string, values: readonly unknown[] = []) => {
      queries.push({ sql, values });
      if (sql.includes("FROM api_entitlement_change_log")) return { rows: [] };
      if (sql.includes("FROM api_commercial_tier_catalog") && sql.includes("catalog.id = $1")) {
        return { rows: [growth] };
      }
      if (sql.includes("FROM api_commercial_tier_catalog")) return { rows: [starter, growth] };
      if (sql.includes("FROM tenant_api_entitlements")) return { rows: [current] };
      if (sql.includes("UPDATE tenant_api_entitlements")) {
        return {
          rows: [
            {
              tier_id: "standard_v1",
              version: 2,
              effective_at: "2026-09-02T00:01:00.000Z",
            },
          ],
        };
      }
      return { rows: [], rowCount: 1 };
    },
    release: () => undefined,
  };
  return { pool: { connect: async () => client } as never, queries };
}

function catalogRow(overrides: Partial<Record<string, unknown>>) {
  return {
    id: "robotmoney_free_v1",
    public_tier_id: "free",
    revision: 1,
    display_name: "Free",
    description: "Accepted RobotMoney tier",
    target_rate_tier_id: "starter_v1",
    billing_mode: "unpaid",
    price_minor_units: 0,
    currency: "USD",
    billing_interval: null,
    price_display: "$0",
    placeholder: false,
    public: true,
    self_serve_enabled: false,
    maximum_agents: 1,
    maximum_entities: 1,
    execution_limit_minor_units: 500000,
    execution_limit_currency: "USD",
    execution_period: "month",
    execution_scope: "per_entity",
    external_api_access: "none",
    external_mcp_access: "none",
    included_api_units: 0,
    included_mcp_units: 0,
    contract_specific: false,
    operator_only: false,
    window_seconds: 60,
    key_limit: 60,
    tenant_limit: 600,
    ...overrides,
  };
}
