import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import {
  CorrelatingAuditEmitter,
  InMemorySlidingWindowRateLimiter,
  authPlugin,
  errorHandlerPlugin,
  requestIdPlugin,
  JwtSigner,
  JwtVerifier,
  newTenantId,
  newUserId,
  type AuditEmitter,
  type AuditEvent,
  type AuditEventInput,
  type Scope,
} from "@brain/shared";
import {
  buildApiKeyAuthenticator,
  hashApiKeySecret,
  registerApiKeyRoutes,
} from "./api-key-routes.js";
import { registerProofRoutes } from "../proof/routes.js";

const HS256_KEY = {
  kty: "oct",
  k: "Y3JlYXRlZF9pbl90ZXN0X2Vudmlyb25tZW50X29ubHlf", // gitleaks:allow
  alg: "HS256",
};
const HS256_SECRET = "created_in_test_environment_only_";
const ISSUER = "https://auth.brain.fi.test";
const AUDIENCE = "https://api.brain.fi.test";
const PEPPER = "test-pepper";

interface FakeApiKeyRow {
  id: string;
  tenant_id: string;
  name: string;
  environment: "sandbox" | "live";
  scopes: Scope[];
  key_prefix: string;
  key_last4: string;
  hashed_secret: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  rotated_from_id: string | null;
}

interface FakeStore {
  tenants: Set<string>;
  apiKeys: Map<string, FakeApiKeyRow>;
  auditEvents: Array<AuditEventInput & { id: string; createdAt: string }>;
}

function makeStore(seedTenantId: string): FakeStore {
  return { tenants: new Set([seedTenantId]), apiKeys: new Map(), auditEvents: [] };
}

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
      if (sql.includes("INSERT INTO api_keys")) {
        const [
          id,
          tenantId,
          name,
          environment,
          scopes,
          keyPrefix,
          keyLast4,
          hashedSecret,
          rotatedFromId,
        ] = values as [
          string,
          string,
          string,
          "sandbox" | "live",
          Scope[],
          string,
          string,
          string,
          string | null,
        ];
        const now = new Date().toISOString();
        const row: FakeApiKeyRow = {
          id,
          tenant_id: tenantId,
          name,
          environment,
          scopes,
          key_prefix: keyPrefix,
          key_last4: keyLast4,
          hashed_secret: hashedSecret,
          created_at: now,
          last_used_at: null,
          revoked_at: null,
          rotated_from_id: rotatedFromId,
        };
        store.apiKeys.set(id, row);
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes("SELECT id, tenant_id, name, environment, scopes")) {
        if (sql.includes("WHERE id = $1 AND revoked_at IS NULL")) {
          const [id] = values as [string];
          const row = store.apiKeys.get(id);
          return row !== undefined && row.revoked_at === null
            ? { rows: [row], rowCount: 1 }
            : { rows: [], rowCount: 0 };
        }
        if (sql.includes("WHERE tenant_id = $1")) {
          const [tenantId] = values as [string];
          const rows = [...store.apiKeys.values()].filter((row) => row.tenant_id === tenantId);
          return { rows, rowCount: rows.length };
        }
      }
      if (sql.includes("UPDATE api_keys") && sql.includes("SET revoked_at = now()")) {
        const [id] = values as [string];
        const row = store.apiKeys.get(id);
        if (row === undefined || row.revoked_at !== null) return { rows: [], rowCount: 0 };
        row.revoked_at = new Date().toISOString();
        return { rows: [{ id }], rowCount: 1 };
      }
      if (sql.includes("UPDATE api_keys SET last_used_at")) {
        const [id] = values as [string];
        const row = store.apiKeys.get(id);
        if (row !== undefined) row.last_used_at = new Date().toISOString();
        return { rows: [], rowCount: row !== undefined ? 1 : 0 };
      }
      if (sql.includes("FROM audit_events e")) {
        const [tenantId] = values as [string];
        const keyFilter = values.find(
          (value) => typeof value === "string" && value.startsWith("akey_"),
        );
        const environmentFilter = values.find((value) => value === "sandbox" || value === "live");
        const counts = new Map<string, number>();
        for (const event of store.auditEvents) {
          if (event.tenantId !== tenantId || event.keyId === undefined) continue;
          if (keyFilter !== undefined && event.keyId !== keyFilter) continue;
          const key = store.apiKeys.get(event.keyId);
          if (environmentFilter !== undefined && key?.environment !== environmentFilter) continue;
          counts.set(event.keyId, (counts.get(event.keyId) ?? 0) + 1);
        }
        const rows = [...counts].map(([key_id, event_count]) => ({
          key_id,
          environment: store.apiKeys.get(key_id)?.environment ?? null,
          event_count,
          first_event_at: new Date().toISOString(),
          last_event_at: new Date().toISOString(),
        }));
        return { rows, rowCount: rows.length };
      }
      throw new Error(`unhandled query in fake pool: ${sql}`);
    },
    release: () => undefined,
  };
  return { connect: async () => client };
}

function makeResolverPool(store: FakeStore) {
  return {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes("WHERE hashed_secret = $1")) {
        const [hashedSecret] = values as [string];
        const row = [...store.apiKeys.values()].find((r) => r.hashed_secret === hashedSecret);
        return row !== undefined ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (sql.includes("SELECT tenant_id FROM api_keys WHERE id = $1")) {
        const [id] = values as [string];
        const row = store.apiKeys.get(id);
        return row !== undefined
          ? { rows: [{ tenant_id: row.tenant_id }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

class StoreAuditEmitter implements AuditEmitter {
  public constructor(private readonly store: FakeStore) {}

  public async emit(event: AuditEventInput): Promise<AuditEvent> {
    const id = `evt_${this.store.auditEvents.length + 1}`;
    const createdAt = new Date().toISOString();
    this.store.auditEvents.push({ ...event, id, createdAt });
    return { ...event, id, createdAt, eventHash: "0".repeat(64), prevEventHash: null };
  }
}

async function adminToken(tenantId: string): Promise<string> {
  const signer = new JwtSigner({
    issuer: ISSUER,
    audience: AUDIENCE,
    key: HS256_KEY,
    algorithm: "HS256",
  });
  return signer.sign({
    id: newUserId(),
    type: "user",
    tenantId,
    tokenId: "token_test",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    scopes: ["execution:admin", "audit:read", "ledger:read"],
  });
}

async function buildApp(
  store: FakeStore,
): Promise<{ app: FastifyInstance; audit: StoreAuditEmitter }> {
  const app = Fastify({ logger: false });
  const pool = makeAppPool(store) as never;
  const resolverPool = makeResolverPool(store) as never;
  const innerAudit = new StoreAuditEmitter(store);
  const audit = new CorrelatingAuditEmitter(innerAudit);
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
    apiKeyAuthenticator: buildApiKeyAuthenticator({
      pool,
      resolverPool,
      pepper: PEPPER,
      rateLimiter: new InMemorySlidingWindowRateLimiter({ windowSeconds: 60, limit: 100 }),
    }),
    apiKeyUsageAudit: audit,
  });
  await registerApiKeyRoutes(app, { pool, resolverPool, audit, pepper: PEPPER });
  app.get("/read-only", async (request) => {
    return { ok: true, key_id: request.apiKeyId ?? null };
  });
  app.get("/audited", async (request) => {
    await audit.emit({
      tenantId: request.principal!.tenantId,
      layer: "audit",
      actor: request.principal!.id,
      action: "audit.test",
      inputs: {},
      outputs: {},
    });
    return { ok: true, key_id: request.apiKeyId ?? null };
  });
  await registerProofRoutes(app, { buildProof: async () => null });
  await app.ready();
  return { app, audit: innerAudit };
}

describe("per-customer API keys", () => {
  it("full lifecycle: issue, use, usage filter, rotate, old key rejected, revoke new key", async () => {
    const tenantId = newTenantId();
    const store = makeStore(tenantId);
    const { app } = await buildApp(store);
    const token = await adminToken(tenantId);
    try {
      const issue = await app.inject({
        method: "POST",
        url: `/tenants/${tenantId}/keys`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          name: "CI integration key",
          environment: "sandbox",
          scopes: ["ledger:read", "audit:read"],
        },
      });
      expect(issue.statusCode).toBe(201);
      const issued = issue.json();
      expect(issued.secret).toMatch(/^brain_sk_test_/);
      expect(issued.id).toMatch(/^akey_/);
      expect(issued.key_prefix).toBe("brain_sk_test_");
      expect(issued.key_last4).toBe(issued.secret.slice(-4));

      const direct = await app.inject({
        method: "GET",
        url: "/audited",
        headers: { authorization: `Bearer ${issued.secret}` },
      });
      expect(direct.statusCode).toBe(200);
      expect(direct.json().key_id).toBe(issued.id);

      const usage = await app.inject({
        method: "GET",
        url: `/tenants/${tenantId}/usage?window=30d&environment=sandbox&key_id=${issued.id}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(usage.statusCode).toBe(200);
      expect(usage.json()).toMatchObject({ total_events: 1, key_id: issued.id });

      const rotate = await app.inject({
        method: "POST",
        url: `/keys/${issued.id}/rotate`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(rotate.statusCode).toBe(201);
      const rotated = rotate.json();
      expect(rotated.secret).toMatch(/^brain_sk_test_/);
      expect(rotated.rotated_from_id).toBe(issued.id);

      const oldRejected = await app.inject({
        method: "GET",
        url: "/audited",
        headers: { authorization: `Bearer ${issued.secret}` },
      });
      expect(oldRejected.statusCode).toBe(401);
      expect(oldRejected.json().error.code).toBe("auth_invalid_key");

      const revoke = await app.inject({
        method: "DELETE",
        url: `/keys/${rotated.id}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(revoke.statusCode).toBe(204);

      const newRejected = await app.inject({
        method: "GET",
        url: "/audited",
        headers: { authorization: `Bearer ${rotated.secret}` },
      });
      expect(newRejected.statusCode).toBe(401);
      expect(newRejected.json().error.code).toBe("auth_invalid_key");
    } finally {
      await app.close();
    }
  });

  it("attributes API key usage for successful read requests without domain audit events", async () => {
    const tenantId = newTenantId();
    const store = makeStore(tenantId);
    const { app } = await buildApp(store);
    const token = await adminToken(tenantId);
    try {
      const issue = await app.inject({
        method: "POST",
        url: `/tenants/${tenantId}/keys`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          name: "CI read key",
          environment: "sandbox",
          scopes: ["ledger:read", "audit:read"],
        },
      });
      expect(issue.statusCode).toBe(201);
      const issued = issue.json();

      const direct = await app.inject({
        method: "GET",
        url: "/read-only",
        headers: { authorization: `Bearer ${issued.secret}` },
      });
      expect(direct.statusCode).toBe(200);
      expect(direct.json().key_id).toBe(issued.id);

      const usage = await app.inject({
        method: "GET",
        url: `/tenants/${tenantId}/usage?window=30d&environment=sandbox&key_id=${issued.id}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(usage.statusCode).toBe(200);
      expect(usage.json()).toMatchObject({ total_events: 1, key_id: issued.id });
      expect(store.auditEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            tenantId,
            actor: issued.id,
            action: "http.request",
            keyId: issued.id,
            inputs: { method: "GET", route: "/read-only" },
            outputs: { status_code: 200 },
          }),
        ]),
      );
    } finally {
      await app.close();
    }
  });

  it("lists only masked keys and never returns plaintext after issue", async () => {
    const tenantId = newTenantId();
    const store = makeStore(tenantId);
    const { app } = await buildApp(store);
    const token = await adminToken(tenantId);
    try {
      await app.inject({
        method: "POST",
        url: `/tenants/${tenantId}/keys`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: "Read key", environment: "live", scopes: ["audit:read"] },
      });
      const list = await app.inject({
        method: "GET",
        url: `/tenants/${tenantId}/keys`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(list.statusCode).toBe(200);
      const key = list.json().keys[0];
      expect(key.key_prefix).toBe("brain_sk_live_");
      expect(key.secret).toBeUndefined();
      expect(key.hashed_secret).toBeUndefined();
      expect(key.masked_key).toMatch(/^brain_sk_live_\.\.\./);
    } finally {
      await app.close();
    }
  });

  it("rejects invalid scopes and cross-tenant admins", async () => {
    const tenantId = newTenantId();
    const store = makeStore(tenantId);
    const { app } = await buildApp(store);
    try {
      const badScope = await app.inject({
        method: "POST",
        url: `/tenants/${tenantId}/keys`,
        headers: { authorization: `Bearer ${await adminToken(tenantId)}` },
        payload: { name: "Bad", environment: "sandbox", scopes: ["raw:read"] },
      });
      expect(badScope.statusCode).toBe(400);

      const crossTenant = await app.inject({
        method: "GET",
        url: `/tenants/${tenantId}/keys`,
        headers: { authorization: `Bearer ${await adminToken(newTenantId())}` },
      });
      expect(crossTenant.statusCode).toBe(403);
      expect(crossTenant.json().error.code).toBe("auth_tenant_mismatch");
    } finally {
      await app.close();
    }
  });

  it("hashes with the server-side pepper", () => {
    const secret = "brain_sk_test_example";
    expect(hashApiKeySecret(secret, "pepper-a")).not.toBe(hashApiKeySecret(secret, "pepper-b"));
  });
});

// Review P3: last_used_at was an unawaited UPDATE fired on every single
// API-key-authenticated request. Fix coalesces writes for the same key into
// at most one per cooldown window (default 60s), using an in-memory
// per-authenticator-instance clock check, no new DB shape, no queue.
//
// The write is deliberately still fire-and-forget (unchanged from before),
// so authenticate() resolves before its background UPDATE promise chain
// necessarily settles. Tests must flush microtasks after each call before
// asserting on writeCount().
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("buildApiKeyAuthenticator - last_used_at cooldown", () => {
  function countingPool(store: FakeStore): { pool: unknown; writeCount: () => number } {
    let writes = 0;
    const client = {
      query: async (sql: string, values: unknown[] = []) => {
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
          return { rows: [], rowCount: 0 };
        }
        if (sql.startsWith("SELECT set_config")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("UPDATE api_keys SET last_used_at")) {
          writes += 1;
          const [id] = values as [string];
          const row = store.apiKeys.get(id);
          if (row !== undefined) row.last_used_at = new Date().toISOString();
          return { rows: [], rowCount: row !== undefined ? 1 : 0 };
        }
        return { rows: [], rowCount: 0 };
      },
    };
    return { pool: { connect: async () => client }, writeCount: () => writes };
  }

  function seedKey(store: FakeStore, tenantId: string, secret: string): string {
    const id = `akey_${store.apiKeys.size + 1}`;
    store.apiKeys.set(id, {
      id,
      tenant_id: tenantId,
      name: "cooldown test key",
      environment: "sandbox",
      scopes: ["ledger:read"],
      key_prefix: "brain_sk_test_",
      key_last4: secret.slice(-4),
      hashed_secret: hashApiKeySecret(secret, PEPPER),
      created_at: new Date().toISOString(),
      last_used_at: null,
      revoked_at: null,
      rotated_from_id: null,
    });
    return id;
  }

  it("writes on the first use, then skips a burst within the cooldown window", async () => {
    const tenantId = newTenantId();
    const store = makeStore(tenantId);
    const secret = "brain_sk_test_cooldown1";
    seedKey(store, tenantId, secret);
    const { pool, writeCount } = countingPool(store);
    let clock = 1_000_000;
    const authenticate = buildApiKeyAuthenticator({
      pool: pool as never,
      resolverPool: makeResolverPool(store) as never,
      pepper: PEPPER,
      lastUsedAtCooldownMs: 60_000,
      now: () => clock,
    });

    await authenticate(secret);
    await flush();
    expect(writeCount()).toBe(1);

    // A burst of calls milliseconds later must not each fire a write.
    clock += 1;
    await authenticate(secret);
    clock += 500;
    await authenticate(secret);
    await flush();
    expect(writeCount()).toBe(1);
  });

  it("writes again once the cooldown window has fully elapsed", async () => {
    const tenantId = newTenantId();
    const store = makeStore(tenantId);
    const secret = "brain_sk_test_cooldown2";
    seedKey(store, tenantId, secret);
    const { pool, writeCount } = countingPool(store);
    let clock = 1_000_000;
    const authenticate = buildApiKeyAuthenticator({
      pool: pool as never,
      resolverPool: makeResolverPool(store) as never,
      pepper: PEPPER,
      lastUsedAtCooldownMs: 60_000,
      now: () => clock,
    });

    await authenticate(secret);
    await flush();
    expect(writeCount()).toBe(1);

    clock += 59_999; // one ms short of the window
    await authenticate(secret);
    await flush();
    expect(writeCount()).toBe(1);

    clock += 1; // now exactly at the window boundary
    await authenticate(secret);
    await flush();
    expect(writeCount()).toBe(2);
  });

  it("tracks each key's cooldown independently", async () => {
    const tenantId = newTenantId();
    const store = makeStore(tenantId);
    const secretA = "brain_sk_test_cooldownA";
    const secretB = "brain_sk_test_cooldownB";
    seedKey(store, tenantId, secretA);
    seedKey(store, tenantId, secretB);
    const { pool, writeCount } = countingPool(store);
    let clock = 1_000_000;
    const authenticate = buildApiKeyAuthenticator({
      pool: pool as never,
      resolverPool: makeResolverPool(store) as never,
      pepper: PEPPER,
      lastUsedAtCooldownMs: 60_000,
      now: () => clock,
    });

    await authenticate(secretA);
    clock += 1;
    await authenticate(secretB);
    await flush();
    expect(writeCount()).toBe(2); // each key's FIRST use always writes

    clock += 1;
    await authenticate(secretA);
    await authenticate(secretB);
    await flush();
    expect(writeCount()).toBe(2); // both still within their own cooldowns
  });

  it("defaults to a 60s cooldown when unset", async () => {
    const tenantId = newTenantId();
    const store = makeStore(tenantId);
    const secret = "brain_sk_test_cooldowndefault";
    seedKey(store, tenantId, secret);
    const { pool, writeCount } = countingPool(store);
    let clock = 1_000_000;
    const authenticate = buildApiKeyAuthenticator({
      pool: pool as never,
      resolverPool: makeResolverPool(store) as never,
      pepper: PEPPER,
      now: () => clock,
    });

    await authenticate(secret);
    clock += 59_999;
    await authenticate(secret);
    await flush();
    expect(writeCount()).toBe(1);

    clock += 1;
    await authenticate(secret);
    await flush();
    expect(writeCount()).toBe(2);
  });
});
