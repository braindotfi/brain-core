import Fastify, { type FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { errorHandlerPlugin, type Principal, type MemberAuthorityRole } from "@brain/shared";
import { registerCommercialTierRoutes } from "./commercial-tier-routes.js";

const tenantId = "tnt_01K123456789ABCDEFGHJKMNPQ";
const otherTenantId = "tnt_01K123456789ABCDEFGHJKMNPR";

describe("commercial tier routes", () => {
  it("returns accepted catalog dimensions to an active tenant admin", async () => {
    const { app, getState } = await buildApp(principal(tenantId, "user"), "admin");
    try {
      const response = await app.inject({
        method: "GET",
        url: `/tenants/${tenantId}/billing/tiers`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        current: { rate_tier_id: "starter_v1", version: 1 },
        available_tiers: [
          {
            catalog_revision_id: "robotmoney_growth_v1",
            placeholder: false,
            price_display: "$499 per month",
            maximum_agents: 5,
            maximum_entities: 1,
            external_access: { api: "included", mcp: "included" },
            included_allowance: { api_units: 25000, mcp_units: 2500 },
            can_upgrade: false,
          },
        ],
      });
      expect(getState).toHaveBeenCalledWith(tenantId);
    } finally {
      await app.close();
    }
  });

  it("applies an admin-confirmed upgrade using session actor and expected version", async () => {
    const { app, upgrade } = await buildApp(principal(tenantId, "user"), "admin");
    try {
      const response = await app.inject({
        method: "POST",
        url: `/tenants/${tenantId}/billing/tier-upgrade`,
        headers: { "idempotency-key": "tier-upgrade-1" },
        payload: {
          catalog_revision_id: "robotmoney_growth_v1",
          expected_entitlement_version: 1,
        },
      });
      expect(response.statusCode).toBe(201);
      expect(upgrade).toHaveBeenCalledWith({
        tenantId,
        actorMemberId: "user_admin",
        idempotencyKey: "tier-upgrade-1",
        catalogRevisionId: "robotmoney_growth_v1",
        expectedEntitlementVersion: 1,
      });
    } finally {
      await app.close();
    }
  });

  it("rejects non-admin, cross-tenant, and machine principals", async () => {
    for (const [actor, role] of [
      [principal(tenantId, "user"), "viewer"],
      [principal(otherTenantId, "user"), "admin"],
      [principal(tenantId, "agent"), "admin"],
    ] as const) {
      const { app, upgrade } = await buildApp(actor, role);
      try {
        const response = await app.inject({
          method: "POST",
          url: `/tenants/${tenantId}/billing/tier-upgrade`,
          headers: { "idempotency-key": "tier-upgrade-denied" },
          payload: {
            catalog_revision_id: "robotmoney_growth_v1",
            expected_entitlement_version: 1,
          },
        });
        expect(response.statusCode).toBe(403);
        expect(upgrade).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    }
  });
});

async function buildApp(actor: Principal, role: MemberAuthorityRole) {
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  app.addHook("preHandler", async (request: FastifyRequest) => {
    request.principal = actor;
  });
  const getState = vi.fn(async () => tierState());
  const upgrade = vi.fn(async () => ({
    changeId: "ctchg_01K123456789ABCDEFGHJKMNPQ",
    catalogRevisionId: "robotmoney_growth_v1",
    previousRateTierId: "starter_v1",
    rateTierId: "standard_v1",
    entitlementVersion: 2,
    effectiveAt: "2026-09-02T00:01:00.000Z",
    placeholder: false,
    paymentRequired: false as const,
  }));
  await registerCommercialTierRoutes(app, {
    pool: memberPool(role),
    service: { getState, upgrade } as never,
  });
  return { app, getState, upgrade };
}

function memberPool(role: MemberAuthorityRole) {
  const client = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("FROM members")) {
        return {
          rows: [
            {
              id: "user_admin",
              tenant_id: tenantId,
              role,
              active: true,
              status: "active",
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  return { connect: vi.fn(async () => client) } as never;
}

function principal(principalTenantId: string, type: "user" | "agent"): Principal {
  return {
    id: "user_admin",
    type,
    tenantId: principalTenantId,
    scopes: ["execution:admin"],
    tokenId: "token_01K123456789ABCDEFGHJKMNPQ",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

function tierState() {
  return {
    current: {
      rateTierId: "starter_v1",
      displayName: "Starter",
      version: 1,
      status: "active",
      limits: { windowSeconds: 60, keyLimit: 60, tenantLimit: 600 },
    },
    availableTiers: [
      {
        catalogRevisionId: "robotmoney_growth_v1",
        publicTierId: "growth",
        revision: 1,
        displayName: "Growth",
        description: "Five agents, one entity, and included API and MCP allowances.",
        targetRateTierId: "standard_v1",
        billingMode: "stripe_subscription" as const,
        priceMinorUnits: 49900,
        currency: "USD",
        billingInterval: "month" as const,
        priceDisplay: "$499 per month",
        placeholder: false,
        canUpgrade: false,
        blockedReason: "self_serve_disabled",
        maximumAgents: 5,
        maximumEntities: 1,
        executionLimit: {
          amountMinorUnits: 25000000,
          currency: "USD",
          period: "month" as const,
          scope: "per_entity" as const,
        },
        externalAccess: { api: "included" as const, mcp: "included" as const },
        includedAllowance: { apiUnits: 25000, mcpUnits: 2500 },
        contractSpecific: false,
        operatorOnly: false,
        limits: { windowSeconds: 60, keyLimit: 300, tenantLimit: 3000 },
      },
    ],
  };
}
