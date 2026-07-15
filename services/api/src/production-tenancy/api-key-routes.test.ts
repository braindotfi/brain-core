import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import {
  authPlugin,
  errorHandlerPlugin,
  requestIdPlugin,
  API_KEY_PERMITTED_SCOPES,
  InMemoryAuditEmitter,
  JwtSigner,
  JwtVerifier,
  newTenantId,
} from "@brain/shared";
import { registerApiKeyRoutes } from "./api-key-routes.js";
import { registerProofRoutes } from "../proof/routes.js";

const HS256_KEY = {
  kty: "oct",
  k: "Y3JlYXRlZF9pbl90ZXN0X2Vudmlyb25tZW50X29ubHlf", // gitleaks:allow
  alg: "HS256",
};
const HS256_SECRET = "created_in_test_environment_only_";
const ISSUER = "https://auth.brain.fi.test";
const AUDIENCE = "https://api.brain.fi.test";
const PLATFORM_SECRET = "platform-secret";

interface FakeAgentRow {
  id: string;
  tenantId: string;
  state: string;
}

interface FakeApiKeyRow {
  token_hash: string;
  key_id: string;
  tenant_id: string;
  agent_id: string;
  scopes: string[];
  name: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
}

interface FakeStore {
  tenants: Set<string>;
  agents: Map<string, FakeAgentRow>;
  apiKeys: Map<string, FakeApiKeyRow>;
}

function makeStore(seedTenantId: string): FakeStore {
  return { tenants: new Set([seedTenantId]), agents: new Map(), apiKeys: new Map() };
}

/** Fake `pg.Pool` backing `withTenantScope`'s `pool.connect()` contract. Real
 * enough to drive the actual SQL branches in api-key-routes.ts against a
 * shared in-memory store, without a real Postgres. */
function makeAppPool(store: FakeStore) {
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (sql.startsWith("SELECT set_config")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("SELECT id FROM tenants WHERE id = $1")) {
        const [id] = values as [string];
        return store.tenants.has(id) ? { rows: [{ id }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (sql.includes("INSERT INTO agents")) {
        const [id, tenantId] = values as [string, string];
        store.agents.set(id, { id, tenantId, state: "active" });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO api_keys")) {
        const [tokenHash, keyId, tenantId, agentId, scopesJson, name, expiresAt] = values as [
          string,
          string,
          string,
          string,
          string,
          string | null,
          string | null,
        ];
        store.apiKeys.set(tokenHash, {
          token_hash: tokenHash,
          key_id: keyId,
          tenant_id: tenantId,
          agent_id: agentId,
          scopes: JSON.parse(scopesJson) as string[],
          name,
          expires_at: expiresAt,
          revoked_at: null,
          last_used_at: null,
        });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("UPDATE api_keys SET last_used_at")) {
        const [tokenHash] = values as [string];
        const row = store.apiKeys.get(tokenHash);
        if (row !== undefined) row.last_used_at = new Date().toISOString();
        return { rows: [], rowCount: row !== undefined ? 1 : 0 };
      }
      if (sql.includes("UPDATE api_keys SET revoked_at")) {
        const [tenantId, keyId] = values as [string, string];
        const found = [...store.apiKeys.values()].find(
          (r) => r.tenant_id === tenantId && r.key_id === keyId && r.revoked_at === null,
        );
        if (found === undefined) return { rows: [], rowCount: 0 };
        found.revoked_at = new Date().toISOString();
        return { rows: [{ agent_id: found.agent_id }], rowCount: 1 };
      }
      if (sql.includes("SELECT 1 AS found FROM api_keys")) {
        const [tenantId, keyId] = values as [string, string];
        const found = [...store.apiKeys.values()].some(
          (r) => r.tenant_id === tenantId && r.key_id === keyId,
        );
        return found ? { rows: [{ found: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (sql.includes("SELECT * FROM agents WHERE id = $1")) {
        const [id] = values as [string];
        const agent = store.agents.get(id);
        if (agent === undefined) return { rows: [], rowCount: 0 };
        return {
          rows: [{ id: agent.id, tenant_id: agent.tenantId, state: agent.state }],
          rowCount: 1,
        };
      }
      if (sql.includes("UPDATE agents SET state = $1")) {
        const [to, id, from] = values as [string, string, string];
        const agent = store.agents.get(id);
        if (agent === undefined || agent.state !== from) return { rows: [], rowCount: 0 };
        agent.state = to;
        return {
          rows: [{ id: agent.id, tenant_id: agent.tenantId, state: agent.state }],
          rowCount: 1,
        };
      }
      throw new Error(`unhandled query in fake pool: ${sql}`);
    },
    release: () => undefined,
  };
  return { connect: async () => client };
}

/** brain_resolver: cross-tenant SELECT on `api_keys` by hash, same shape as
 * findRefreshToken's use of resolverPool in production-tenancy/routes.ts. */
function makeResolverPool(store: FakeStore) {
  return {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes("FROM api_keys WHERE token_hash")) {
        const [tokenHash] = values as [string];
        const row = store.apiKeys.get(tokenHash);
        return row !== undefined ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

async function buildApp(
  store: FakeStore,
): Promise<{ app: FastifyInstance; audit: InMemoryAuditEmitter }> {
  const app = Fastify({ logger: false });
  await app.register(requestIdPlugin);
  await app.register(errorHandlerPlugin);
  await app.register(authPlugin, {
    verifier: new JwtVerifier({
      jwksUrl: "https://auth.brain.fi.test/.well-known/jwks.json",
      secret: HS256_SECRET,
      issuer: ISSUER,
      audience: AUDIENCE,
      clockToleranceSeconds: 5,
    }),
  });
  const audit = new InMemoryAuditEmitter();
  const signer = new JwtSigner({
    issuer: ISSUER,
    audience: AUDIENCE,
    key: HS256_KEY,
    algorithm: "HS256",
  });
  await registerApiKeyRoutes(app, {
    pool: makeAppPool(store) as never,
    resolverPool: makeResolverPool(store) as never,
    audit,
    signer,
    platformSecret: PLATFORM_SECRET,
  });
  // Stand-in protected route to prove an exchanged token actually
  // authenticates, the same way login.test.ts proves it against /raw/ingest.
  app.get("/whoami", async (request) => ({
    id: request.principal?.id,
    tenantId: request.principal?.tenantId,
    scopes: request.principal?.scopes,
  }));
  // The real audit:read-gated route (GET /proof/:action_id), mounted so a
  // lifecycle test can prove an issued key's audit:read scope actually
  // clears requireScope on a real handler, not just a stand-in. buildProof
  // always misses (404) -- the point is confirming we get past the 401/403
  // scope gate, not exercising the proof assembler.
  await registerProofRoutes(app, { buildProof: async () => null });
  await app.ready();
  return { app, audit };
}

describe("per-customer API-key auth (token-exchange model)", () => {
  it("full lifecycle: issue -> exchange -> authed call -> revoke -> exchange rejected", async () => {
    const tenantId = newTenantId();
    const store = makeStore(tenantId);
    const { app, audit } = await buildApp(store);
    try {
      const issue = await app.inject({
        method: "POST",
        url: `/tenants/${tenantId}/api-keys`,
        headers: { "x-platform-service-auth": PLATFORM_SECRET },
        payload: { name: "CI integration key" },
      });
      expect(issue.statusCode).toBe(201);
      const issued = issue.json();
      expect(issued.api_key).toMatch(/^brain_sk_/);
      expect(issued.key_id).toMatch(/^akey_/);
      expect(issued.agent_id).toMatch(/^agent_/);
      expect(issued.scopes).toContain("payment_intent:propose");
      expect(audit.events.map((e) => e.action)).toContain("auth.api_key.issued");

      const exchange1 = await app.inject({
        method: "POST",
        url: "/auth/api-key",
        headers: { "x-api-key": issued.api_key },
      });
      expect(exchange1.statusCode).toBe(200);
      const token1 = exchange1.json();
      expect(token1.token_type).toBe("Bearer");
      expect(token1.tenant_id).toBe(tenantId);
      expect(token1.agent_id).toBe(issued.agent_id);
      expect(audit.events.map((e) => e.action)).toContain("auth.api_key.exchanged");

      const authed = await app.inject({
        method: "GET",
        url: "/whoami",
        headers: { authorization: `Bearer ${token1.token}` },
      });
      expect(authed.statusCode).toBe(200);
      expect(authed.json()).toMatchObject({
        id: issued.agent_id,
        tenantId,
        scopes: issued.scopes,
      });

      const revoke = await app.inject({
        method: "DELETE",
        url: `/tenants/${tenantId}/api-keys/${issued.key_id}`,
        headers: { "x-platform-service-auth": PLATFORM_SECRET },
      });
      expect(revoke.statusCode).toBe(204);
      expect(audit.events.map((e) => e.action)).toContain("auth.api_key.revoked");
      expect(store.agents.get(issued.agent_id)?.state).toBe("revoked");

      const exchange2 = await app.inject({
        method: "POST",
        url: "/auth/api-key",
        headers: { "x-api-key": issued.api_key },
      });
      expect(exchange2.statusCode).toBe(401);
      expect(exchange2.json().error.code).toBe("auth_header_invalid");
    } finally {
      await app.close();
    }
  });

  it("rejects exchange for an unknown key with the same generic 401 as a revoked one", async () => {
    const tenantId = newTenantId();
    const store = makeStore(tenantId);
    const { app } = await buildApp(store);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/auth/api-key",
        headers: { "x-api-key": "brain_sk_never_issued" },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("auth_header_invalid");
    } finally {
      await app.close();
    }
  });

  it("rejects exchange when the X-Api-Key header is missing", async () => {
    const tenantId = newTenantId();
    const store = makeStore(tenantId);
    const { app } = await buildApp(store);
    try {
      const res = await app.inject({ method: "POST", url: "/auth/api-key" });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("404s issuance for a tenant that does not exist", async () => {
    const store = makeStore(newTenantId());
    const { app } = await buildApp(store);
    try {
      const res = await app.inject({
        method: "POST",
        url: `/tenants/${newTenantId()}/api-keys`,
        headers: { "x-platform-service-auth": PLATFORM_SECRET },
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("400s issuance for a scope outside API_KEY_PERMITTED_SCOPES", async () => {
    const tenantId = newTenantId();
    const store = makeStore(tenantId);
    const { app } = await buildApp(store);
    try {
      const res = await app.inject({
        method: "POST",
        url: `/tenants/${tenantId}/api-keys`,
        headers: { "x-platform-service-auth": PLATFORM_SECRET },
        payload: { scopes: ["payment_intent:approve"] },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("401s issuance and revocation without the platform credential", async () => {
    const tenantId = newTenantId();
    const store = makeStore(tenantId);
    const { app } = await buildApp(store);
    try {
      const issue = await app.inject({
        method: "POST",
        url: `/tenants/${tenantId}/api-keys`,
        payload: {},
      });
      expect(issue.statusCode).toBe(401);

      const revoke = await app.inject({
        method: "DELETE",
        url: `/tenants/${tenantId}/api-keys/akey_bogus`,
      });
      expect(revoke.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("404s revocation of a never-issued key id", async () => {
    const tenantId = newTenantId();
    const store = makeStore(tenantId);
    const { app, audit } = await buildApp(store);
    try {
      const res = await app.inject({
        method: "DELETE",
        url: `/tenants/${tenantId}/api-keys/akey_never_issued`,
        headers: { "x-platform-service-auth": PLATFORM_SECRET },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("api_key_not_found");
      expect(audit.events.map((e) => e.action)).not.toContain("auth.api_key.revoked");
    } finally {
      await app.close();
    }
  });

  it("double-revoke: first call revokes and audits, second is an idempotent 204 no-op", async () => {
    const tenantId = newTenantId();
    const store = makeStore(tenantId);
    const { app, audit } = await buildApp(store);
    try {
      const issue = await app.inject({
        method: "POST",
        url: `/tenants/${tenantId}/api-keys`,
        headers: { "x-platform-service-auth": PLATFORM_SECRET },
        payload: {},
      });
      const { key_id: keyId } = issue.json();

      const revoke1 = await app.inject({
        method: "DELETE",
        url: `/tenants/${tenantId}/api-keys/${keyId}`,
        headers: { "x-platform-service-auth": PLATFORM_SECRET },
      });
      expect(revoke1.statusCode).toBe(204);
      const revokedCountAfterFirst = audit.events.filter(
        (e) => e.action === "auth.api_key.revoked",
      ).length;
      expect(revokedCountAfterFirst).toBe(1);

      const revoke2 = await app.inject({
        method: "DELETE",
        url: `/tenants/${tenantId}/api-keys/${keyId}`,
        headers: { "x-platform-service-auth": PLATFORM_SECRET },
      });
      expect(revoke2.statusCode).toBe(204);
      const revokedCountAfterSecond = audit.events.filter(
        (e) => e.action === "auth.api_key.revoked",
      ).length;
      expect(revokedCountAfterSecond).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("default (no scopes in body) issuance stays within API_KEY_PERMITTED_SCOPES, includes audit:read, excludes money-move scopes", async () => {
    const tenantId = newTenantId();
    const store = makeStore(tenantId);
    const { app } = await buildApp(store);
    try {
      const res = await app.inject({
        method: "POST",
        url: `/tenants/${tenantId}/api-keys`,
        headers: { "x-platform-service-auth": PLATFORM_SECRET },
        payload: {},
      });
      expect(res.statusCode).toBe(201);
      const { scopes } = res.json();
      expect(scopes.length).toBeGreaterThan(0);
      for (const s of scopes as string[]) {
        expect(API_KEY_PERMITTED_SCOPES.has(s as never)).toBe(true);
      }
      // Product decision: a default-issued API key CAN read its own tenant's
      // audit trail.
      expect(scopes).toContain("audit:read");
      // But it can never move money or administer anything.
      for (const moneyMove of [
        "payment_intent:approve",
        "payment_intent:execute",
        "execution:admin",
      ]) {
        expect(scopes).not.toContain(moneyMove);
      }
    } finally {
      await app.close();
    }
  });

  it("a default-issued key's audit:read scope actually clears a real audit-gated route (GET /proof/:id)", async () => {
    const tenantId = newTenantId();
    const store = makeStore(tenantId);
    const { app } = await buildApp(store);
    try {
      const issue = await app.inject({
        method: "POST",
        url: `/tenants/${tenantId}/api-keys`,
        headers: { "x-platform-service-auth": PLATFORM_SECRET },
        payload: {},
      });
      const issued = issue.json();
      expect(issued.scopes).toContain("audit:read");

      const exchange = await app.inject({
        method: "POST",
        url: "/auth/api-key",
        headers: { "x-api-key": issued.api_key },
      });
      const { token } = exchange.json();

      const proof = await app.inject({
        method: "GET",
        url: "/proof/action_never_issued",
        headers: { authorization: `Bearer ${token}` },
      });
      // 404 (buildProof stubbed to always miss), NOT 401/403 -- proves
      // requireScope("audit:read") on the real proof route passed.
      expect(proof.statusCode).toBe(404);
      expect(proof.json().error.code).toBe("proof_not_found");
    } finally {
      await app.close();
    }
  });
});
