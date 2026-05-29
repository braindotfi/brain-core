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
    scopes: [] as unknown as Principal["scopes"],
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

interface BuildOpts {
  principal: Principal | undefined;
}

async function buildApp(opts: BuildOpts) {
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  app.addHook("preHandler", async (request: FastifyRequest) => {
    if (opts.principal !== undefined) {
      request.principal = opts.principal;
    }
  });
  const pool = {
    connect: vi.fn(() =>
      Promise.resolve({
        query: vi.fn((sql: string) =>
          Promise.resolve({
            rows: [],
            rowCount: sql.startsWith("DELETE") ? 1 : 0,
          }),
        ),
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
      const r = await app.inject({ method: "DELETE", url: `/tenants/${TENANT_A}` });
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
});
