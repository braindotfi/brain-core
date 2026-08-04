import { describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyRequest } from "fastify";
import {
  InMemoryAuditEmitter,
  errorHandlerPlugin,
  newTenantId,
  type Principal,
} from "@brain/shared";
import { registerTenantDeletionRoute } from "./route.js";
import { TenantDeletionService } from "./service.js";

const TENANT_A = newTenantId();
const TENANT_B = newTenantId();
const USER = "usr_01TESTUSER000000000000000";
const AGENT = "agent_01TESTAGENT0000000000000";

function userPrincipal(tenantId: string): Principal {
  return {
    id: USER,
    type: "user",
    tenantId,
    scopes: ["execution:admin"] as unknown as Principal["scopes"],
    tokenId: "tok_01TEST00000000000000000",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

function agentPrincipal(tenantId: string): Principal {
  return {
    id: AGENT,
    type: "agent",
    tenantId,
    scopes: [] as unknown as Principal["scopes"],
    tokenId: "tok_01TEST00000000000000000",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

function viewerPrincipal(tenantId: string): Principal {
  return {
    id: USER,
    type: "user",
    tenantId,
    scopes: ["ledger:read"] as unknown as Principal["scopes"],
    tokenId: "tok_01TEST00000000000000000",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

interface BuildOpts {
  principal: Principal | undefined;
  /** F2: overrides the live members-row role requireAdminMember re-checks. */
  memberRole?: "admin" | "approver" | "viewer";
}

async function buildApp(opts: BuildOpts) {
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  app.addHook("preHandler", async (request: FastifyRequest) => {
    if (opts.principal !== undefined) {
      request.principal = opts.principal;
    }
  });
  const memberRole = opts.memberRole ?? "admin";
  const pool = {
    connect: vi.fn(() =>
      Promise.resolve({
        query: vi.fn((sql: string, values?: unknown[]) => {
          // F2: requireAdminMember's live re-check. Every USER fixture in
          // this file represents an active member of its own tenant with
          // `memberRole`, unless a test overrides it.
          if (sql.includes("FROM members")) {
            const [memberId, tenantId] = (values ?? []) as [string, string];
            return Promise.resolve({
              rows: [
                { id: memberId, tenant_id: tenantId, role: memberRole, active: true, status: "active" },
              ],
              rowCount: 1,
            });
          }
          return Promise.resolve({
            rows: [],
            rowCount: sql.startsWith("DELETE") ? 1 : 0,
          });
        }),
        release: vi.fn(),
      }),
    ),
  };
  const audit = new InMemoryAuditEmitter();
  const service = new TenantDeletionService({
    privilegedPool: pool as never,
    audit,
  });
  await registerTenantDeletionRoute(app, { service });
  return { app, audit };
}

describe("DELETE /v1/tenants/{id}", () => {
  it("permits a tenant user to delete their own tenant data", async () => {
    const { app, audit } = await buildApp({ principal: userPrincipal(TENANT_A) });
    try {
      const r = await app.inject({
        method: "DELETE",
        url: `/tenants/${TENANT_A}`,
        payload: { confirm: TENANT_A },
      });
      expect(r.statusCode).toBe(200);
      const body = r.json() as { tenantId: string; totalRows: number };
      expect(body.tenantId).toBe(TENANT_A);
      expect(body.totalRows).toBeGreaterThan(0);
      expect(audit.events).toHaveLength(1);
      expect(audit.events[0]!.action).toBe("tenant.deleted");
    } finally {
      await app.close();
    }
  });

  it("rejects cross-tenant deletion (auth_tenant_mismatch)", async () => {
    const { app } = await buildApp({ principal: userPrincipal(TENANT_A) });
    try {
      const r = await app.inject({ method: "DELETE", url: `/tenants/${TENANT_B}` });
      expect(r.statusCode).toBe(403);
      const body = r.json() as { error: { code: string } };
      expect(body.error.code).toBe("auth_tenant_mismatch");
    } finally {
      await app.close();
    }
  });

  it("rejects agent principals (only users may request erasure)", async () => {
    const { app } = await buildApp({ principal: agentPrincipal(TENANT_A) });
    try {
      const r = await app.inject({ method: "DELETE", url: `/tenants/${TENANT_A}` });
      expect(r.statusCode).toBe(403);
      const body = r.json() as { error: { code: string } };
      expect(body.error.code).toBe("auth_scope_insufficient");
    } finally {
      await app.close();
    }
  });

  it("rejects unauthenticated requests", async () => {
    const { app } = await buildApp({ principal: undefined });
    try {
      const r = await app.inject({ method: "DELETE", url: `/tenants/${TENANT_A}` });
      expect(r.statusCode).toBe(401);
      const body = r.json() as { error: { code: string } };
      expect(body.error.code).toBe("auth_token_missing");
    } finally {
      await app.close();
    }
  });

  it("F2: a viewer-scoped token (no execution:admin) cannot delete a tenant", async () => {
    const { app } = await buildApp({ principal: viewerPrincipal(TENANT_A) });
    try {
      const r = await app.inject({
        method: "DELETE",
        url: `/tenants/${TENANT_A}`,
        payload: { confirm: TENANT_A },
      });
      expect(r.statusCode).toBe(403);
      const body = r.json() as { error: { code: string } };
      expect(body.error.code).toBe("auth_scope_insufficient");
    } finally {
      await app.close();
    }
  });

  it("F2: a stale execution:admin token is rejected once the live member row is not admin", async () => {
    const { app } = await buildApp({
      principal: userPrincipal(TENANT_A),
      memberRole: "viewer",
    });
    try {
      const r = await app.inject({
        method: "DELETE",
        url: `/tenants/${TENANT_A}`,
        payload: { confirm: TENANT_A },
      });
      expect(r.statusCode).toBe(403);
      const body = r.json() as { error: { code: string } };
      expect(body.error.code).toBe("auth_scope_insufficient");
    } finally {
      await app.close();
    }
  });

  it("F2: rejects deletion without the tenant-id confirmation echo", async () => {
    const { app } = await buildApp({ principal: userPrincipal(TENANT_A) });
    try {
      const r = await app.inject({ method: "DELETE", url: `/tenants/${TENANT_A}` });
      expect(r.statusCode).toBe(400);
      const body = r.json() as { error: { code: string } };
      expect(body.error.code).toBe("request_body_invalid");
    } finally {
      await app.close();
    }
  });
});
