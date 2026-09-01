import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import {
  CorrelatingAuditEmitter,
  InMemoryApiSlidingWindowRateLimiter,
  authPlugin,
  errorHandlerPlugin,
  requestIdPlugin,
  JwtSigner,
  JwtVerifier,
  newTenantId,
  newUserId,
  requireScope,
  type AuditEmitter,
  type AuditEvent,
  type AuditEventInput,
  type ApiRequestMeter,
  type ApiRequestMeterEvent,
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
  expires_at: string | null;
  rotated_from_id: string | null;
}

interface FakeTenantState {
  provisioning_state: "provisioning" | "ready_demo" | "seed_failed" | "archived" | null;
  data_profile: "synthetic_brightline_v1" | "customer" | null;
  access_stage: "demo" | "production_review" | "production" | null;
}

interface FakeStore {
  tenants: Set<string>;
  tenantStates: Map<string, FakeTenantState>;
  apiKeys: Map<string, FakeApiKeyRow>;
  auditEvents: Array<AuditEventInput & { id: string; createdAt: string }>;
  requestMeterEvents: ApiRequestMeterEvent[];
}

function makeStore(seedTenantId: string): FakeStore {
  return {
    tenants: new Set([seedTenantId]),
    tenantStates: new Map([
      [
        seedTenantId,
        { provisioning_state: null, data_profile: "customer", access_stage: "production" },
      ],
    ]),
    apiKeys: new Map(),
    auditEvents: [],
    requestMeterEvents: [],
  };
}

function makeVerifiedSynthetic(store: FakeStore, tenantId: string): void {
  store.tenantStates.set(tenantId, {
    provisioning_state: "ready_demo",
    data_profile: "synthetic_brightline_v1",
    access_stage: "demo",
  });
}

function makeAppPool(
  store: FakeStore,
  // requireAdminMember's live re-check (F1). Every token minted by this
  // file's adminToken() represents an admin member of its tenant by default;
  // tests that need to simulate a stale token (scope says admin, live row
  // does not) override this.
  memberRole: (memberId: string, tenantId: string) => "admin" | "approver" | "viewer" = () =>
    "admin",
) {
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (sql.startsWith("SELECT set_config")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("FROM tenants") && sql.includes("WHERE id = $1")) {
        const [id] = values as [string];
        const state = store.tenantStates.get(id);
        return store.tenants.has(id) && state !== undefined
          ? { rows: [state], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (sql.includes("FROM members")) {
        const [memberId, tenantId] = values as [string, string];
        return store.tenants.has(tenantId)
          ? {
              rows: [
                {
                  id: memberId,
                  tenant_id: tenantId,
                  role: memberRole(memberId, tenantId),
                  active: true,
                  status: "active",
                },
              ],
              rowCount: 1,
            }
          : { rows: [], rowCount: 0 };
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
          expires_at: null,
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
      if (sql.includes("FROM api_request_meter_events e")) {
        const [tenantId] = values as [string];
        const keyFilter = values.find(
          (value) => typeof value === "string" && value.startsWith("akey_"),
        );
        const environmentFilter = values.find((value) => value === "sandbox" || value === "live");
        const counts = new Map<string, number>();
        for (const event of store.requestMeterEvents) {
          if (event.tenantId !== tenantId) continue;
          if (keyFilter !== undefined && event.keyId !== keyFilter) continue;
          if (environmentFilter !== undefined && event.environment !== environmentFilter) continue;
          counts.set(event.keyId, (counts.get(event.keyId) ?? 0) + 1);
        }
        const rows = [...counts].map(([key_id, request_count]) => ({
          key_id,
          environment: store.apiKeys.get(key_id)?.environment ?? null,
          request_count,
          first_request_at: new Date().toISOString(),
          last_request_at: new Date().toISOString(),
        }));
        return { rows, rowCount: rows.length };
      }
      if (sql.includes("FROM tenant_api_entitlements ent")) {
        return {
          rows: [
            {
              tier_id: "sandbox_demo_v1",
              display_name: "Demo",
              entitlement_version: 1,
              status: "active",
              window_seconds: 60,
              key_limit: 600,
              tenant_limit: 6000,
              override_key_limit: null,
              override_version: null,
              override_expires_at: null,
            },
          ],
          rowCount: 1,
        };
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
      if (sql.includes("WHERE k.key_prefix = $1 AND k.key_last4 = $2")) {
        const [keyPrefix, keyLast4] = values as [string, string];
        const rows = [...store.apiKeys.values()]
          .filter((row) => row.key_prefix === keyPrefix && row.key_last4 === keyLast4)
          .map((row) => ({
            ...row,
            ...store.tenantStates.get(row.tenant_id),
            tier_id: row.environment === "sandbox" ? "sandbox_demo_v1" : "starter_v1",
            tier_display_name: row.environment === "sandbox" ? "Demo" : "Starter",
            entitlement_version: 1,
            entitlement_status: "active",
            rate_window_seconds: 60,
            tier_key_limit: 100,
            tenant_limit: 1000,
            override_key_limit: null,
            override_expires_at: null,
          }));
        return { rows, rowCount: rows.length };
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

class StoreRequestMeter implements ApiRequestMeter {
  public constructor(private readonly store: FakeStore) {}

  public async record(event: ApiRequestMeterEvent): Promise<void> {
    this.store.requestMeterEvents.push(event);
  }
}

async function sessionToken(tenantId: string, scopes: Scope[]): Promise<string> {
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
    scopes,
  });
}

async function adminToken(tenantId: string): Promise<string> {
  return sessionToken(tenantId, ["execution:admin", "audit:read", "ledger:read"]);
}

async function buildApp(
  store: FakeStore,
  memberRole?: (memberId: string, tenantId: string) => "admin" | "approver" | "viewer",
): Promise<{ app: FastifyInstance; audit: StoreAuditEmitter }> {
  const app = Fastify({ logger: false });
  const pool = makeAppPool(store, memberRole) as never;
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
      rateLimiter: new InMemoryApiSlidingWindowRateLimiter(),
    }),
    apiKeyRequestMeter: new StoreRequestMeter(store),
  });
  await registerApiKeyRoutes(app, { pool, resolverPool, audit, pepper: PEPPER });
  app.get("/read-only", async (request) => {
    return { ok: true, key_id: request.apiKeyId ?? null };
  });
  app.get("/ledger-scope", async (request) => {
    requireScope(request.principal!.scopes, "ledger:read");
    return { ok: true, key_id: request.apiKeyId ?? null };
  });
  app.get("/audit-scope", async (request) => {
    requireScope(request.principal!.scopes, "audit:read");
    return { ok: true, key_id: request.apiKeyId ?? null };
  });
  app.get("/raw-read-scope", async (request) => {
    requireScope(request.principal!.scopes, "raw:read");
    return { ok: true, key_id: request.apiKeyId ?? null };
  });
  app.post("/raw-write-scope", async (request) => {
    requireScope(request.principal!.scopes, "raw:write");
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
      expect(usage.json()).toMatchObject({
        total_requests: 1,
        total_events: 1,
        key_id: issued.id,
        entitlement: {
          tier_id: "sandbox_demo_v1",
          display_name: "Demo",
          entitlement_version: 1,
          window_seconds: 60,
          key_limit: 600,
          tenant_limit: 6000,
          effective_key_limit: 600,
          key_override: null,
        },
      });

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
      expect(store.requestMeterEvents.filter((event) => event.outcome === "auth_rejected")).toEqual(
        [
          expect.objectContaining({
            keyId: issued.id,
            tenantId,
            rejectionReason: "revoked",
            statusCode: 401,
          }),
          expect.objectContaining({
            keyId: rotated.id,
            tenantId,
            rejectionReason: "revoked",
            statusCode: 401,
          }),
        ],
      );
    } finally {
      await app.close();
    }
  });

  it("attributes API key usage without creating a domain audit substitute", async () => {
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
      expect(usage.json()).toMatchObject({
        total_requests: 1,
        total_events: 1,
        key_id: issued.id,
      });
      expect(store.requestMeterEvents).toEqual([
        expect.objectContaining({
          tenantId,
          keyId: issued.id,
          method: "GET",
          routeTemplate: "/read-only",
          outcome: "success",
        }),
      ]);
      expect(store.auditEvents.some((event) => event.action === "http.request")).toBe(false);
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

  it("rejects scopes outside both API key allowlists and cross-tenant admins", async () => {
    const tenantId = newTenantId();
    const store = makeStore(tenantId);
    const { app } = await buildApp(store);
    try {
      const badScope = await app.inject({
        method: "POST",
        url: `/tenants/${tenantId}/keys`,
        headers: { authorization: `Bearer ${await adminToken(tenantId)}` },
        payload: { name: "Bad", environment: "sandbox", scopes: ["execution:propose"] },
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

  it("issues and uses raw scopes only for a verified synthetic demo sandbox key", async () => {
    const tenantId = newTenantId();
    const store = makeStore(tenantId);
    makeVerifiedSynthetic(store, tenantId);
    const { app } = await buildApp(store);
    const token = await adminToken(tenantId);
    try {
      const issue = await app.inject({
        method: "POST",
        url: `/tenants/${tenantId}/keys`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          name: "Synthetic Raw key",
          environment: "sandbox",
          scopes: ["raw:read", "raw:write"],
        },
      });
      expect(issue.statusCode).toBe(201);
      const issued = issue.json();
      expect(issued.secret).toMatch(/^brain_sk_test_/);
      expect(issued.scopes).toEqual(["raw:read", "raw:write"]);

      const read = await app.inject({
        method: "GET",
        url: "/raw-read-scope",
        headers: { authorization: `Bearer ${issued.secret}` },
      });
      expect(read.statusCode).toBe(200);

      const write = await app.inject({
        method: "POST",
        url: "/raw-write-scope",
        headers: { authorization: `Bearer ${issued.secret}` },
      });
      expect(write.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it.each([
    [null, null, null],
    ["provisioning", "synthetic_brightline_v1", "demo"],
    ["seed_failed", "synthetic_brightline_v1", "demo"],
    ["archived", "synthetic_brightline_v1", "demo"],
    ["ready_demo", "customer", "demo"],
    ["ready_demo", "synthetic_brightline_v1", "production_review"],
    ["ready_demo", "synthetic_brightline_v1", "production"],
  ] as const)(
    "rejects raw scope issuance for tenant state %s/%s/%s",
    async (provisioningState, dataProfile, accessStage) => {
      const tenantId = newTenantId();
      const store = makeStore(tenantId);
      store.tenantStates.set(tenantId, {
        provisioning_state: provisioningState,
        data_profile: dataProfile,
        access_stage: accessStage,
      });
      const { app } = await buildApp(store);
      try {
        const issue = await app.inject({
          method: "POST",
          url: `/tenants/${tenantId}/keys`,
          headers: { authorization: `Bearer ${await adminToken(tenantId)}` },
          payload: { name: "Denied Raw key", environment: "sandbox", scopes: ["raw:read"] },
        });
        expect(issue.statusCode).toBe(400);
        expect(issue.json().error).toMatchObject({
          code: "request_body_invalid",
          details: {
            environment: "sandbox",
            provisioning_state: provisioningState,
            data_profile: dataProfile,
            access_stage: accessStage,
          },
        });
        expect(store.apiKeys.size).toBe(0);
      } finally {
        await app.close();
      }
    },
  );

  it("rejects raw scopes on a live key even for a verified synthetic demo tenant", async () => {
    const tenantId = newTenantId();
    const store = makeStore(tenantId);
    makeVerifiedSynthetic(store, tenantId);
    const { app } = await buildApp(store);
    try {
      const issue = await app.inject({
        method: "POST",
        url: `/tenants/${tenantId}/keys`,
        headers: { authorization: `Bearer ${await adminToken(tenantId)}` },
        payload: { name: "Live Raw key", environment: "live", scopes: ["raw:write"] },
      });
      expect(issue.statusCode).toBe(400);
      expect(issue.json().error).toMatchObject({
        code: "request_body_invalid",
        details: { environment: "live" },
      });
      expect(store.apiKeys.size).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("fails a demo Raw key closed at use and rotation time after tenant state changes", async () => {
    const tenantId = newTenantId();
    const store = makeStore(tenantId);
    makeVerifiedSynthetic(store, tenantId);
    const { app } = await buildApp(store);
    const token = await adminToken(tenantId);
    try {
      const issue = await app.inject({
        method: "POST",
        url: `/tenants/${tenantId}/keys`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: "Graduating Raw key", environment: "sandbox", scopes: ["raw:write"] },
      });
      expect(issue.statusCode).toBe(201);
      const issued = issue.json();

      store.tenantStates.set(tenantId, {
        provisioning_state: "ready_demo",
        data_profile: "synthetic_brightline_v1",
        access_stage: "production_review",
      });

      const use = await app.inject({
        method: "POST",
        url: "/raw-write-scope",
        headers: { authorization: `Bearer ${issued.secret}` },
      });
      expect(use.statusCode).toBe(401);
      expect(use.json().error.code).toBe("auth_invalid_key");
      expect(store.requestMeterEvents).toEqual([
        expect.objectContaining({
          keyId: issued.id,
          tenantId,
          outcome: "auth_rejected",
          rejectionReason: "tenant_ineligible",
        }),
      ]);

      const rotate = await app.inject({
        method: "POST",
        url: `/keys/${issued.id}/rotate`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(rotate.statusCode).toBe(400);
      expect(rotate.json().error.code).toBe("request_body_invalid");
      expect(store.apiKeys.get(issued.id)?.revoked_at).toBeNull();
      expect(store.apiKeys.size).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("rejects a Raw-scoped key whose stored environment uses the live prefix", async () => {
    const tenantId = newTenantId();
    const store = makeStore(tenantId);
    makeVerifiedSynthetic(store, tenantId);
    const secret = "brain_sk_live_forgedraw";
    store.apiKeys.set("akey_forged", {
      id: "akey_forged",
      tenant_id: tenantId,
      name: "Forged Raw key",
      environment: "live",
      scopes: ["raw:read"],
      key_prefix: "brain_sk_live_",
      key_last4: secret.slice(-4),
      hashed_secret: hashApiKeySecret(secret, PEPPER),
      created_at: new Date().toISOString(),
      last_used_at: null,
      revoked_at: null,
      expires_at: null,
      rotated_from_id: null,
    });
    const authenticate = buildApiKeyAuthenticator({
      pool: makeAppPool(store) as never,
      resolverPool: makeResolverPool(store) as never,
      pepper: PEPPER,
      rateLimiter: new InMemoryApiSlidingWindowRateLimiter(),
    });

    await expect(authenticate(secret)).resolves.toMatchObject({
      kind: "known_rejected",
      reason: "tenant_ineligible",
      attribution: { keyId: "akey_forged", tenantId },
    });
  });

  it("enforces route scopes carried by the key principal", async () => {
    const tenantId = newTenantId();
    const store = makeStore(tenantId);
    const { app } = await buildApp(store);
    const token = await adminToken(tenantId);
    try {
      const issue = await app.inject({
        method: "POST",
        url: `/tenants/${tenantId}/keys`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: "Ledger only", environment: "sandbox", scopes: ["ledger:read"] },
      });
      expect(issue.statusCode).toBe(201);
      const issued = issue.json();

      const ledger = await app.inject({
        method: "GET",
        url: "/ledger-scope",
        headers: { authorization: `Bearer ${issued.secret}` },
      });
      expect(ledger.statusCode).toBe(200);

      const audit = await app.inject({
        method: "GET",
        url: "/audit-scope",
        headers: { authorization: `Bearer ${issued.secret}` },
      });
      expect(audit.statusCode).toBe(403);
      expect(audit.json().error.code).toBe("auth_scope_insufficient");
    } finally {
      await app.close();
    }
  });

  it("rejects cross-tenant reads with a valid API key", async () => {
    const tenantId = newTenantId();
    const otherTenantId = newTenantId();
    const store = makeStore(tenantId);
    store.tenants.add(otherTenantId);
    const { app } = await buildApp(store);
    const token = await adminToken(tenantId);
    try {
      const issue = await app.inject({
        method: "POST",
        url: `/tenants/${tenantId}/keys`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: "Audit key", environment: "sandbox", scopes: ["audit:read"] },
      });
      expect(issue.statusCode).toBe(201);
      const issued = issue.json();

      const response = await app.inject({
        method: "GET",
        url: `/tenants/${otherTenantId}/usage`,
        headers: { authorization: `Bearer ${issued.secret}` },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("auth_tenant_mismatch");
    } finally {
      await app.close();
    }
  });

  it("F1: a viewer-scoped session (no execution:admin) cannot mint a tenant key", async () => {
    const tenantId = newTenantId();
    const store = makeStore(tenantId);
    const { app } = await buildApp(store);
    const viewerToken = await sessionToken(tenantId, ["ledger:read", "audit:read"]);
    try {
      const r = await app.inject({
        method: "POST",
        url: `/tenants/${tenantId}/keys`,
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: { name: "should not mint", environment: "sandbox", scopes: ["ledger:read"] },
      });
      expect(r.statusCode).toBe(403);
      expect(r.json().error.code).toBe("auth_scope_insufficient");
    } finally {
      await app.close();
    }
  });

  it("F1: a stale execution:admin token is rejected once the live member row is not admin", async () => {
    const tenantId = newTenantId();
    const store = makeStore(tenantId);
    // Scope still says admin (token minted before a demotion), but the live
    // members row -- what requireAdminMember re-checks -- says viewer.
    const { app } = await buildApp(store, () => "viewer");
    const staleToken = await adminToken(tenantId);
    try {
      const r = await app.inject({
        method: "POST",
        url: `/tenants/${tenantId}/keys`,
        headers: { authorization: `Bearer ${staleToken}` },
        payload: { name: "should not mint", environment: "sandbox", scopes: ["ledger:read"] },
      });
      expect(r.statusCode).toBe(403);
      expect(r.json().error.code).toBe("auth_scope_insufficient");
    } finally {
      await app.close();
    }
  });

  it("keeps brain_sk_ fail-closed when the authenticator is disabled", async () => {
    const app = Fastify({ logger: false });
    await app.register(errorHandlerPlugin);
    await app.register(authPlugin, {
      verifier: {} as unknown as JwtVerifier,
    });
    app.get("/probe", async () => ({ ok: true }));
    await app.ready();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/probe",
        headers: { authorization: "Bearer brain_sk_test_disabled" },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe("auth_invalid_key");
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

  function seedKey(
    store: FakeStore,
    tenantId: string,
    secret: string,
    overrides: Partial<Pick<FakeApiKeyRow, "expires_at" | "revoked_at">> = {},
  ): string {
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
      revoked_at: overrides.revoked_at ?? null,
      expires_at: overrides.expires_at ?? null,
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
      rateLimiter: new InMemoryApiSlidingWindowRateLimiter(),
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
      rateLimiter: new InMemoryApiSlidingWindowRateLimiter(),
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
      rateLimiter: new InMemoryApiSlidingWindowRateLimiter(),
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
      rateLimiter: new InMemoryApiSlidingWindowRateLimiter(),
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

  it("rejects expired and wrong secrets while accepting a valid key", async () => {
    const tenantId = newTenantId();
    const store = makeStore(tenantId);
    const validSecret = "brain_sk_test_valid_expiry";
    const expiredSecret = "brain_sk_test_expired";
    seedKey(store, tenantId, validSecret);
    seedKey(store, tenantId, expiredSecret, {
      expires_at: new Date(Date.now() - 1_000).toISOString(),
    });
    const { pool } = countingPool(store);
    const authenticate = buildApiKeyAuthenticator({
      pool: pool as never,
      resolverPool: makeResolverPool(store) as never,
      pepper: PEPPER,
      rateLimiter: new InMemoryApiSlidingWindowRateLimiter(),
    });

    await expect(authenticate(validSecret)).resolves.toMatchObject({
      principal: { tenantId, scopes: ["ledger:read"] },
    });
    await expect(authenticate(expiredSecret)).resolves.toMatchObject({
      kind: "known_rejected",
      reason: "expired",
    });
    await expect(authenticate("brain_sk_test_wrong")).resolves.toMatchObject({
      kind: "unknown_rejected",
      reason: "unknown",
    });
  });

  it("rate-limits by API key id", async () => {
    const tenantId = newTenantId();
    const store = makeStore(tenantId);
    const secret = "brain_sk_test_rate_limited";
    seedKey(store, tenantId, secret);
    const { pool } = countingPool(store);
    const authenticate = buildApiKeyAuthenticator({
      pool: pool as never,
      resolverPool: makeResolverPool(store) as never,
      pepper: PEPPER,
      rateLimiter: new InMemoryApiSlidingWindowRateLimiter(),
    });

    await expect(authenticate(secret, { requestId: "req_1" })).resolves.toBeTruthy();
    const key = [...store.apiKeys.values()][0]!;
    const originalResolver = makeResolverPool(store);
    const restrictedAuthenticate = buildApiKeyAuthenticator({
      pool: pool as never,
      resolverPool: {
        query: async (sql: string, values: unknown[] = []) => {
          const result = await originalResolver.query(sql, values);
          return {
            ...result,
            rows: result.rows.map((row) =>
              "id" in row && row.id === key.id ? { ...row, tier_key_limit: 1 } : row,
            ),
          };
        },
      } as never,
      pepper: PEPPER,
      rateLimiter: new InMemoryApiSlidingWindowRateLimiter(),
    });
    await expect(restrictedAuthenticate(secret, { requestId: "req_2" })).resolves.toBeTruthy();
    await expect(restrictedAuthenticate(secret, { requestId: "req_3" })).resolves.toMatchObject({
      kind: "known_rejected",
      reason: "rate_limited",
      rateLimit: { allowed: false, limit: 1, count: 2, rejectedBy: "key" },
    });
  });

  it("fails closed after a known key match when Redis is unavailable", async () => {
    const tenantId = newTenantId();
    const store = makeStore(tenantId);
    const secret = "brain_sk_test_redis_failure";
    seedKey(store, tenantId, secret);
    const { pool } = countingPool(store);
    const authenticate = buildApiKeyAuthenticator({
      pool: pool as never,
      resolverPool: makeResolverPool(store) as never,
      pepper: PEPPER,
      rateLimiter: {
        hit: async () => {
          throw new Error("redis unavailable");
        },
      },
    });

    await expect(authenticate(secret, { requestId: "req_redis_down" })).resolves.toMatchObject({
      kind: "known_rejected",
      attribution: { tenantId },
      reason: "rate_limiter_unavailable",
    });
  });

  it("caps a key override at the tenant tier key limit", async () => {
    const tenantId = newTenantId();
    const store = makeStore(tenantId);
    const secret = "brain_sk_test_restrictive_override";
    seedKey(store, tenantId, secret);
    const { pool } = countingPool(store);
    const resolver = makeResolverPool(store);
    const seenLimits: number[] = [];
    const authenticateWithOverride = (overrideKeyLimit: number) =>
      buildApiKeyAuthenticator({
        pool: pool as never,
        resolverPool: {
          query: async (sql: string, values: unknown[] = []) => {
            const result = await resolver.query(sql, values);
            return {
              ...result,
              rows: result.rows.map((row) => ({ ...row, override_key_limit: overrideKeyLimit })),
            };
          },
        } as never,
        pepper: PEPPER,
        rateLimiter: {
          hit: async (input) => {
            seenLimits.push(input.policy.keyLimit);
            return {
              allowed: true,
              count: 1,
              limit: input.policy.keyLimit,
              tenantCount: 1,
              tenantLimit: input.policy.tenantLimit,
              rejectedBy: null,
              policy: input.policy,
            };
          },
        },
      });

    await expect(
      authenticateWithOverride(10)(secret, { requestId: "req_restricted" }),
    ).resolves.toMatchObject({ kind: "authenticated" });
    await expect(
      authenticateWithOverride(1000)(secret, { requestId: "req_elevated" }),
    ).resolves.toMatchObject({ kind: "authenticated" });
    expect(seenLimits).toEqual([10, 100]);
  });
});
