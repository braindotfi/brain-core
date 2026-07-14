import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import {
  InMemoryRevocationStore,
  authPlugin,
  errorHandlerPlugin,
  JwtSigner,
  JwtVerifier,
  newTenantId,
  type Principal,
} from "@brain/shared";
import { ActorResolver } from "@brain/execution";
import { registerMemberRoutes } from "@brain/execution";
import { registerProductionTenancyRoutes } from "./routes.js";
import { SERVICE_TOKEN_SCOPES } from "../onboarding/service-token.js";

const platformSecret = "platform-secret";
const HS256_KEY = {
  kty: "oct",
  k: "Y3JlYXRlZF9pbl90ZXN0X2Vudmlyb25tZW50X29ubHlf", // gitleaks:allow
  alg: "HS256",
};
const HS256_SECRET = "created_in_test_environment_only_";
const ISSUER = "https://auth.brain.fi.test";
const AUDIENCE = "https://api.brain.fi.test";

interface QueryCall {
  sql: string;
  values?: unknown[];
}

interface AgentRow {
  id: string;
  tenant_id: string;
  display_name: string;
  state: "active" | "revoked";
}

interface ProductionAgentTokenRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  expires_at_epoch: number;
  revoked_at: string | null;
}

function memberRow(overrides: Record<string, unknown> = {}) {
  return {
    tenant_id: newTenantId(),
    id: "user_bootstrap",
    email: "founder@example.com",
    display_name: "Founder",
    role: "admin",
    status: "active",
    active: true,
    approval_domains: ["ap", "ar", "treasury", "payroll", "reconciliation"],
    per_item_limit_cents: "9223372036854775807",
    requires_second_approver_above_cents: null,
    ...overrides,
  };
}

function appPool(member = memberRow()) {
  const calls: QueryCall[] = [];
  const tenants = new Map<string, "production" | "demo">();
  const agents = new Map<string, AgentRow>();
  const productionAgentTokens = new Map<string, ProductionAgentTokenRow>();
  const client = {
    query: vi.fn((sql: string, values?: unknown[]) => {
      calls.push(values === undefined ? { sql } : { sql, values });
      if (
        sql === "BEGIN" ||
        sql === "COMMIT" ||
        sql === "ROLLBACK" ||
        sql.startsWith("SELECT set_config")
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (sql.includes("INSERT INTO tenants (id, kind, sandbox, created_via)")) {
        const [tenantId] = values as [string];
        tenants.set(tenantId, "production");
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (sql.includes("SELECT kind FROM tenants WHERE id = $1")) {
        const [tenantId] = values as [string];
        const kind = tenants.get(tenantId) ?? "production";
        return Promise.resolve({ rows: [{ kind }], rowCount: 1 });
      }
      if (sql.includes("FROM members") && sql.includes("WHERE id = $1")) {
        return Promise.resolve({ rows: [member], rowCount: 1 });
      }
      if (sql.includes("FROM agents") && sql.includes("display_name = $1")) {
        const [displayName] = values as [string];
        const row = [...agents.values()].find(
          (agent) => agent.display_name === displayName && agent.state === "active",
        );
        return Promise.resolve({
          rows: row === undefined ? [] : [{ id: row.id }],
          rowCount: row === undefined ? 0 : 1,
        });
      }
      if (sql.includes("INSERT INTO agents")) {
        const [id, tenantId, displayName] = values as [string, string, string];
        agents.set(id, { id, tenant_id: tenantId, display_name: displayName, state: "active" });
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (sql.includes("INSERT INTO production_agent_tokens")) {
        const [id, tenantId, agentId, expiresAt] = values as [string, string, string, number];
        productionAgentTokens.set(id, {
          id,
          tenant_id: tenantId,
          agent_id: agentId,
          expires_at_epoch: expiresAt,
          revoked_at: null,
        });
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (sql.includes("FROM production_agent_tokens") && sql.includes("revoked_at IS NULL")) {
        const [tenantId, agentId] = values as [string, string];
        const row = [...productionAgentTokens.values()]
          .filter(
            (token) =>
              token.tenant_id === tenantId &&
              token.agent_id === agentId &&
              token.revoked_at === null &&
              token.expires_at_epoch > Math.floor(Date.now() / 1000),
          )
          .sort((a, b) => b.expires_at_epoch - a.expires_at_epoch)[0];
        return Promise.resolve({
          rows:
            row === undefined ? [] : [{ id: row.id, expires_at_epoch: row.expires_at_epoch }],
          rowCount: row === undefined ? 0 : 1,
        });
      }
      if (sql.includes("UPDATE production_agent_tokens")) {
        const [tenantId, agentId] = values as [string, string];
        const rows = [...productionAgentTokens.values()]
          .filter(
            (token) =>
              token.tenant_id === tenantId &&
              token.agent_id === agentId &&
              token.revoked_at === null &&
              token.expires_at_epoch > Math.floor(Date.now() / 1000),
          )
          .map((token) => {
            token.revoked_at = new Date().toISOString();
            return { id: token.id, expires_at_epoch: token.expires_at_epoch };
          });
        return Promise.resolve({ rows, rowCount: rows.length });
      }
      if (sql.startsWith("UPDATE members")) {
        return Promise.resolve({
          rows: [{ ...member, status: "active", active: true }],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    }),
    release: vi.fn(),
  };
  return {
    calls,
    tenants,
    agents,
    productionAgentTokens,
    pool: { connect: vi.fn(() => Promise.resolve(client)) },
  };
}

function resolverPool(rows: unknown[] = []) {
  return {
    query: vi.fn(() => Promise.resolve({ rows, rowCount: rows.length })),
  };
}

async function build(opts: { appRows?: unknown[]; resolverRows?: unknown[] } = {}) {
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  const appDb = appPool(opts.appRows?.[0] === undefined ? memberRow() : (opts.appRows[0] as never));
  const resolver = resolverPool(opts.resolverRows ?? []);
  const audit = { emit: vi.fn(async () => ({ id: "audit_1" })) };
  const signer = { sign: vi.fn(async () => "access-token") };
  await registerProductionTenancyRoutes(app, {
    pool: appDb.pool as never,
    resolverPool: resolver as never,
    audit: audit as never,
    signer: signer as never,
    platformSecret,
  });
  return { app, appDb, resolver, audit, signer };
}

async function buildWithJwt(opts: { member?: ReturnType<typeof memberRow> } = {}) {
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  const revocation = new InMemoryRevocationStore();
  await app.register(authPlugin, {
    verifier: new JwtVerifier({
      jwksUrl: "https://auth.brain.fi.test/.well-known/jwks.json",
      secret: HS256_SECRET,
      issuer: ISSUER,
      audience: AUDIENCE,
      clockToleranceSeconds: 5,
      revocation,
    }),
  });
  const appDb = appPool(opts.member ?? memberRow());
  const resolver = resolverPool([]);
  const audit = { emit: vi.fn(async () => ({ id: "audit_1" })) };
  const signer = new JwtSigner({
    issuer: ISSUER,
    audience: AUDIENCE,
    key: HS256_KEY,
    algorithm: "HS256",
  });
  await registerProductionTenancyRoutes(app, {
    pool: appDb.pool as never,
    resolverPool: resolver as never,
    audit: audit as never,
    signer,
    revocation,
    platformSecret,
  });
  await registerMemberRoutes(app, { pool: appDb.pool as never, audit: audit as never });
  return { app, appDb, resolver, audit, signer, revocation };
}

describe("production tenancy routes", () => {
  it("creates a production tenant with one bootstrap admin, member session, and propose-only agent", async () => {
    const { app, appDb, signer } = await build();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/tenants",
        headers: { "x-platform-service-auth": platformSecret },
        payload: {
          company_name: "Acme",
          founder: { email: "founder@example.com", display_name: "Founder" },
          founder_external_ref: "platform-user-1",
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.session.token).toBe("access-token");
      expect(body.session.refresh_token).toBeTypeOf("string");
      expect(body.member.role).toBe("admin");
      expect(body.agent).toMatchObject({
        token: "access-token",
        principal_type: "agent",
        subject: expect.stringMatching(/^agent_/),
        scopes: SERVICE_TOKEN_SCOPES,
        use: "propose-only agent workflows",
      });
      expect(body.agent.scopes).not.toContain("payment_intent:approve");
      expect(body.agent.scopes).not.toContain("payment_intent:execute");
      expect(
        appDb.calls.some((c) =>
          c.sql.includes("INSERT INTO tenants (id, kind, sandbox, created_via)"),
        ),
      ).toBe(true);
      expect(
        appDb.calls.some(
          (c) =>
            c.sql.includes("INSERT INTO member_identity_links") && c.sql.includes("'platform'"),
        ),
      ).toBe(true);
      expect(signer.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "user",
          scopes: expect.arrayContaining(["execution:admin"]),
        }),
      );
      expect(signer.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "agent",
          scopes: SERVICE_TOKEN_SCOPES,
        }),
      );
      expect(appDb.agents.size).toBe(1);
      expect(appDb.productionAgentTokens.size).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("returns an existing production agent token idempotently without rotation", async () => {
    const { app, appDb } = await build();
    try {
      const tenantId = newTenantId();
      appDb.tenants.set(tenantId, "production");
      const first = await app.inject({
        method: "POST",
        url: `/tenants/${tenantId}/agent-token`,
        headers: { "x-platform-service-auth": platformSecret },
      });
      expect(first.statusCode).toBe(201);
      const firstBody = first.json();

      const second = await app.inject({
        method: "POST",
        url: `/tenants/${tenantId}/agent-token`,
        headers: { "x-platform-service-auth": platformSecret },
      });
      expect(second.statusCode).toBe(200);
      const secondBody = second.json();
      expect(secondBody.token_id).toBe(firstBody.token_id);
      expect(appDb.productionAgentTokens.size).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("rotates a production agent token, revokes the prior token, and never audits bearer values", async () => {
    const { app, appDb, audit, signer } = await build();
    try {
      const tenantId = newTenantId();
      appDb.tenants.set(tenantId, "production");
      const first = await app.inject({
        method: "POST",
        url: `/tenants/${tenantId}/agent-token`,
        headers: { "x-platform-service-auth": platformSecret },
      });
      expect(first.statusCode).toBe(201);
      const firstBody = first.json();

      const rotated = await app.inject({
        method: "POST",
        url: `/tenants/${tenantId}/agent-token`,
        headers: { "x-platform-service-auth": platformSecret },
        payload: { rotate: true },
      });
      expect(rotated.statusCode).toBe(201);
      const rotatedBody = rotated.json();
      expect(rotatedBody.token_id).not.toBe(firstBody.token_id);
      expect(appDb.productionAgentTokens.get(firstBody.token_id)?.revoked_at).not.toBeNull();
      expect(appDb.productionAgentTokens.size).toBe(2);
      const tokenAudit = (
        audit.emit.mock.calls as unknown as Array<
          [{ action: string; outputs: Record<string, unknown> }]
        >
      )
        .map((call) => call[0])
        .filter((event) => event.action === "auth.production_agent_token.minted");
      expect(tokenAudit[tokenAudit.length - 1]?.outputs).toMatchObject({
        token_id: rotatedBody.token_id,
        revoked_token_ids: [firstBody.token_id],
      });
      expect(JSON.stringify(tokenAudit)).not.toContain(firstBody.token);
      expect(signer.sign).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: "agent", scopes: SERVICE_TOKEN_SCOPES }),
      );
    } finally {
      await app.close();
    }
  });

  it("rejects production agent minting for non-production tenants", async () => {
    const { app, appDb } = await build();
    try {
      const tenantId = newTenantId();
      appDb.tenants.set(tenantId, "demo");
      const res = await app.inject({
        method: "POST",
        url: `/tenants/${tenantId}/agent-token`,
        headers: { "x-platform-service-auth": platformSecret },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.details.reason).toBe("production_agent_required");
      expect(appDb.productionAgentTokens.size).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("production-minted agent tokens authenticate as agents but get actor_unresolved on member routes and approval actor resolution", async () => {
    const { app } = await buildWithJwt();
    try {
      const created = await app.inject({
        method: "POST",
        url: "/tenants",
        headers: { "x-platform-service-auth": platformSecret },
        payload: {
          company_name: "Acme",
          founder: { email: "founder@example.com", display_name: "Founder" },
          founder_external_ref: "platform-user-1",
        },
      });
      expect(created.statusCode).toBe(201);
      const body = created.json();
      const members = await app.inject({
        method: "GET",
        url: "/members",
        headers: { authorization: `Bearer ${body.agent.token}` },
      });
      expect(members.statusCode).toBe(403);
      expect(members.json().error.details).toMatchObject({
        reason: "actor_unresolved",
        source: "session",
        principal_type: "agent",
      });

      const resolver = new ActorResolver({
        members: {
          findMemberById: vi.fn(async () => null),
          findMemberByEmail: vi.fn(async () => null),
          findMemberByIdentityLink: vi.fn(async () => null),
        },
      });
      const ctx = {
        tenantId: body.tenant_id,
        actor: body.agent.subject,
        principalType: "agent" as const,
        scopes: body.agent.scopes as Principal["scopes"],
      };
      await expect(resolver.resolve({ kind: "session", ctx })).rejects.toMatchObject({
        details: {
          reason: "actor_unresolved",
          source: "session",
          principal_type: "agent",
        },
      });
    } finally {
      await app.close();
    }
  });

  it("rejects demo-fence auth on production tenant creation", async () => {
    const { app } = await build();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/tenants",
        headers: {
          "x-platform-service-auth": platformSecret,
          "x-demo-provision-auth": "demo-secret",
        },
        payload: {
          founder: { email: "founder@example.com" },
          founder_external_ref: "platform-user-1",
        },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().reason).toBe("platform_service_credential_required");
    } finally {
      await app.close();
    }
  });

  it("does not auto-create a session for an unlinked platform identity", async () => {
    const { app, appDb } = await build({ resolverRows: [] });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/sessions",
        headers: { "x-platform-service-auth": platformSecret },
        payload: { external_ref: "missing-user" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().reason).toBe("session_identity_unlinked");
      expect(appDb.calls.some((c) => c.sql.includes("INSERT INTO session_refresh_tokens"))).toBe(
        false,
      );
    } finally {
      await app.close();
    }
  });

  it("returns the exact invalid reason for a bad invite token", async () => {
    const { app, appDb } = await build({ resolverRows: [] });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/invites/consume",
        headers: { "x-platform-service-auth": platformSecret },
        payload: { invite_token: "bad-token", external_ref: "platform-user-2" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().reason).toBe("invite_invalid");
      expect(appDb.calls.some((c) => c.sql.includes("member_identity_links"))).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("revokes a refresh family when a rotated token is reused", async () => {
    const tenantId = newTenantId();
    const refresh = {
      tenant_id: tenantId,
      member_id: "user_1",
      token_hash: "unused",
      family_id: "token_family",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      rotated_at: new Date().toISOString(),
      revoked_at: null,
    };
    const { app, appDb } = await build({ resolverRows: [refresh] });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/sessions/refresh",
        payload: { refresh_token: "any-token" },
      });
      expect(res.statusCode).toBe(401);
      expect(
        appDb.calls.some(
          (c) => c.sql.includes("UPDATE session_refresh_tokens") && c.sql.includes("family_id"),
        ),
      ).toBe(true);
    } finally {
      await app.close();
    }
  });
});
