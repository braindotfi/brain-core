import Fastify, { type FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { errorHandlerPlugin, newTenantId, newUserId, type Principal } from "@brain/shared";
import type { GraduationRequestRecord } from "./repository.js";
import { registerGraduationRoutes } from "./routes.js";

const tenantId = newTenantId();
const otherTenantId = newTenantId();
const memberId = newUserId();

describe("graduation routes", () => {
  it("lets a live tenant admin submit a normalized profile", async () => {
    const { app, submit } = await buildApp(adminPrincipal(tenantId), "admin");
    try {
      const response = await app.inject({
        method: "POST",
        url: `/tenants/${tenantId}/graduation/verification`,
        headers: { "idempotency-key": "graduation-1" },
        payload: profileBody(),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        tenant_id: tenantId,
        status: "manual_review",
        next_action: "await_manual_review",
      });
      expect(submit).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId,
          actorMemberId: memberId,
          idempotencyKey: "graduation-1",
          profile: expect.objectContaining({
            businessEmail: "owner@brightline.example",
            registrationCountry: "US",
            website: "https://brightline.example/",
          }),
        }),
      );
    } finally {
      await app.close();
    }
  });

  it("rejects stale admin scopes when the live member is not an admin", async () => {
    const { app, submit } = await buildApp(adminPrincipal(tenantId), "viewer");
    try {
      const response = await app.inject({
        method: "POST",
        url: `/tenants/${tenantId}/graduation/verification`,
        headers: { "idempotency-key": "graduation-1" },
        payload: profileBody(),
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: "auth_scope_insufficient" } });
      expect(submit).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("rejects cross-tenant and machine principals before reading graduation state", async () => {
    for (const principal of [adminPrincipal(otherTenantId), agentPrincipal(tenantId)]) {
      const { app, submit } = await buildApp(principal, "admin");
      try {
        const response = await app.inject({
          method: "POST",
          url: `/tenants/${tenantId}/graduation/verification`,
          headers: { "idempotency-key": "graduation-1" },
          payload: profileBody(),
        });
        expect(response.statusCode).toBe(403);
        expect(submit).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    }
  });

  it("requires an idempotency key and structurally valid business evidence", async () => {
    const { app, submit } = await buildApp(adminPrincipal(tenantId), "admin");
    try {
      const missingKey = await app.inject({
        method: "POST",
        url: `/tenants/${tenantId}/graduation/verification`,
        payload: profileBody(),
      });
      expect(missingKey.statusCode).toBe(400);

      const insecureWebsite = await app.inject({
        method: "POST",
        url: `/tenants/${tenantId}/graduation/verification`,
        headers: { "idempotency-key": "graduation-2" },
        payload: profileBody({ website: "http://brightline.example" }),
      });
      expect(insecureWebsite.statusCode).toBe(400);
      expect(submit).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns the current status without exposing stored business evidence", async () => {
    const { app } = await buildApp(adminPrincipal(tenantId), "admin");
    try {
      const response = await app.inject({
        method: "GET",
        url: `/tenants/${tenantId}/graduation`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        graduation: { status: "manual_review", next_action: "await_manual_review" },
      });
      expect(response.body).not.toContain("owner@brightline.example");
      expect(response.body).not.toContain("Brightline Labs");
    } finally {
      await app.close();
    }
  });

  it("lets an active tenant admin complete an approved unpaid graduation", async () => {
    const { app, complete } = await buildApp(adminPrincipal(tenantId), "admin");
    try {
      const response = await app.inject({
        method: "POST",
        url: `/tenants/${tenantId}/graduation/complete-unpaid`,
        headers: { "idempotency-key": "graduation-complete-1" },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({
        lineage: {
          source_tenant_id: tenantId,
          destination_tenant_id: otherTenantId,
          graduation_mode: "unpaid",
          financial_data_copied: false,
        },
        session: { token: "member-token", refresh_token: "refresh-token" },
        agent: { id: "agent_destination", token: "agent-token" },
      });
      expect(complete).toHaveBeenCalledWith({
        sourceTenantId: tenantId,
        actorMemberId: memberId,
        idempotencyKey: "graduation-complete-1",
      });
    } finally {
      await app.close();
    }
  });
});

async function buildApp(principal: Principal, memberRole: "admin" | "viewer") {
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  app.addHook("preHandler", async (request: FastifyRequest) => {
    request.principal = principal;
  });
  const record = graduationRecord();
  const submit = vi.fn(async () => record);
  const complete = vi.fn(async () => provisioningResult());
  await registerGraduationRoutes(app, {
    pool: fakePool(memberRole),
    service: { submit, getCurrent: vi.fn(async () => record) },
    provisioning: { complete },
  });
  return { app, submit, complete };
}

function fakePool(role: "admin" | "viewer"): Pool {
  const client = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("FROM members")) {
        return {
          rows: [
            {
              id: memberId,
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
  return { connect: vi.fn(async () => client) } as unknown as Pool;
}

function adminPrincipal(principalTenantId: string): Principal {
  return {
    id: memberId,
    type: "user",
    tenantId: principalTenantId,
    scopes: ["execution:admin"],
    tokenId: "token_01K123456789ABCDEFGHJKMN",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

function agentPrincipal(principalTenantId: string): Principal {
  return { ...adminPrincipal(principalTenantId), type: "agent" };
}

function profileBody(overrides: Record<string, unknown> = {}) {
  return {
    business_profile: {
      legal_business_name: "Brightline Labs",
      business_email: "OWNER@BRIGHTLINE.EXAMPLE",
      website: "https://brightline.example",
      registration_country: "us",
      intended_use: "Financial operations",
      expected_monthly_requests: 1000,
      ...overrides,
    },
  };
}

function graduationRecord(): GraduationRequestRecord {
  return {
    id: "grad_01K123456789ABCDEFGHJKMNPQ",
    tenantId,
    status: "manual_review",
    profileHash: "profile-hash",
    policyVersion: "graduation_pending_compliance_v1",
    verifiedMemberEmail: "owner@brightline.example",
    assessment: {
      id: "gva_01K123456789ABCDEFGHJKMNPQ",
      outcome: "manual_review",
      signals: [
        {
          checkId: "approved_compliance_policy_v1",
          outcome: "manual_review",
          reasonCode: "compliance_policy_not_configured",
          confidence: 1,
        },
      ],
      assessedAt: "2026-09-02T00:00:01.000Z",
    },
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:01.000Z",
  };
}

function provisioningResult() {
  return {
    lineage: {
      id: "gvl_01K123456789ABCDEFGHJKMNPQ",
      requestId: "grad_01K123456789ABCDEFGHJKMNPQ",
      sourceTenantId: tenantId,
      destinationTenantId: otherTenantId,
      destinationMemberId: "user_01K123456789ABCDEFGHJKMNPQ",
      graduationMode: "unpaid" as const,
      copiedFields: {
        business: {
          legal_business_name: "Brightline Labs",
          registration_country: "US",
          company_registration_number: null,
          website: "https://brightline.example/",
          business_email: "owner@brightline.example",
        },
        bootstrap_member: {
          email: "owner@brightline.example",
          display_name: "Owner",
          role: "admin" as const,
        },
      },
      excludedDataClasses: ["ledger", "raw"],
      financialDataCopied: false as const,
      createdAt: "2026-09-02T00:00:02.000Z",
    },
    session: { token: "member-token", refreshToken: "refresh-token", expiresIn: 900 },
    agent: {
      id: "agent_destination",
      token: "agent-token",
      tokenId: "token_destination",
      expiresAt: 1_788_328_000,
    },
  };
}
