import Fastify from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  AGENT_API_KEY_PROFILE_SCOPES,
  InMemoryAuditEmitter,
  InMemoryIdempotencyStore,
  errorHandlerPlugin,
  hashAgentApiKey,
  requestIdPlugin,
} from "@brain/shared";
import { registerAgentApiKeyRoutes } from "./agent-key-routes.js";
import { SERVICE_TOKEN_SCOPES } from "../onboarding/service-token.js";

const TENANT_ID = "tnt_00000000010000000000000000";
const OTHER_TENANT_ID = "tnt_00000000010000000000000009";
const AGENT_ID = "agent_00000000020000000000000001";
const PLATFORM_SECRET = "platform-test-secret";
const PEPPER = "agent-key-test-pepper";

interface StoredKey {
  id: string;
  tenant_id: string;
  agent_id: string;
  profile: "document_extractor_v1" | "bff_service_v1";
  environment: "test" | "live";
  scopes: string[];
  hashed_secret: string;
  key_prefix: string;
  key_last4: string;
  name: string;
  created_at: string;
  last_used_at: null;
  expires_at: string;
  revoked_at: string | null;
  rotated_from_id: string | null;
}

function makePools(keys: Map<string, StoredKey>) {
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (sql.startsWith("SELECT set_config")) return { rows: [], rowCount: 1 };
      if (sql.includes("SELECT kind FROM tenants")) {
        return values[0] === TENANT_ID
          ? { rows: [{ kind: "production" }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (sql.includes("FROM agents")) {
        return values[0] === TENANT_ID && values[1] === AGENT_ID
          ? {
              rows: [
                {
                  id: AGENT_ID,
                  kind: "internal",
                  display_name: "BFF Service Agent",
                  state: "active",
                },
              ],
              rowCount: 1,
            }
          : { rows: [], rowCount: 0 };
      }
      if (sql.includes("INSERT INTO agent_api_keys")) {
        const [
          id,
          tenantId,
          agentId,
          profile,
          environment,
          scopes,
          hashedSecret,
          keyPrefix,
          keyLast4,
          name,
          _ttl,
          rotatedFromId,
        ] = values as [
          string,
          string,
          string,
          StoredKey["profile"],
          StoredKey["environment"],
          string[],
          string,
          string,
          string,
          string,
          number,
          string | null,
        ];
        const now = new Date();
        const row: StoredKey = {
          id,
          tenant_id: tenantId,
          agent_id: agentId,
          profile,
          environment,
          scopes,
          hashed_secret: hashedSecret,
          key_prefix: keyPrefix,
          key_last4: keyLast4,
          name,
          created_at: now.toISOString(),
          last_used_at: null,
          expires_at: new Date(now.getTime() + 90 * 86_400_000).toISOString(),
          revoked_at: null,
          rotated_from_id: rotatedFromId,
        };
        keys.set(id, row);
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes("FROM agent_api_keys") && sql.includes("WHERE tenant_id = $1")) {
        const rows = [...keys.values()].filter((key) => key.tenant_id === values[0]);
        return { rows, rowCount: rows.length };
      }
      if (
        sql.includes("FROM agent_api_keys") &&
        sql.includes("revoked_at IS NULL") &&
        sql.includes("FOR UPDATE")
      ) {
        const key = keys.get(values[0] as string);
        return key !== undefined && key.revoked_at === null
          ? { rows: [key], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (sql.includes("UPDATE agent_api_keys SET revoked_at = now()")) {
        const key = keys.get(values[0] as string);
        if (key !== undefined) key.revoked_at = new Date().toISOString();
        return { rows: [], rowCount: key === undefined ? 0 : 1 };
      }
      if (sql.includes("WHERE id = $1 AND revoked_at IS NULL")) {
        const key = keys.get(values[0] as string);
        if (key === undefined || key.revoked_at !== null) return { rows: [], rowCount: 0 };
        key.revoked_at = new Date().toISOString();
        return { rows: [{ agent_id: key.agent_id }], rowCount: 1 };
      }
      throw new Error(`unexpected app query: ${sql}`);
    },
    release: () => undefined,
  };
  return {
    pool: { connect: async () => client } as unknown as Pool,
    resolverPool: {
      query: async (_sql: string, values: unknown[]) => {
        const key = keys.get(values[0] as string);
        return key === undefined
          ? { rows: [], rowCount: 0 }
          : { rows: [{ tenant_id: key.tenant_id }], rowCount: 1 };
      },
    } as unknown as Pool,
  };
}

describe("platform-managed agent API key lifecycle", () => {
  let keys: Map<string, StoredKey>;

  beforeEach(() => {
    keys = new Map();
  });

  it("keeps the bff_service_v1 profile identical to the legacy BFF token scopes", () => {
    expect(AGENT_API_KEY_PROFILE_SCOPES.bff_service_v1).toEqual(SERVICE_TOKEN_SCOPES);
  });

  async function buildApp() {
    const pools = makePools(keys);
    const audit = new InMemoryAuditEmitter();
    const app = Fastify({ logger: false });
    app.addHook("onRequest", async (request) => {
      const tenantId = request.headers["x-test-principal-tenant"];
      if (typeof tenantId === "string") {
        request.principal = {
          id: AGENT_ID,
          type: "agent",
          tenantId,
          scopes: ["tenant:agent-mint"],
          tokenId: "tok_00000000030000000000000001",
          expiresAt: Math.floor(Date.now() / 1000) + 300,
        };
      }
    });
    await app.register(requestIdPlugin);
    await app.register(errorHandlerPlugin);
    await registerAgentApiKeyRoutes(app, {
      ...pools,
      audit,
      pepper: PEPPER,
      environment: "live",
      platformSecret: PLATFORM_SECRET,
      idempotencyStore: new InMemoryIdempotencyStore(),
      idempotencyTtlSeconds: 86_400,
    });
    await app.ready();
    return { app, audit };
  }

  function createPayload(profile: StoredKey["profile"]) {
    return {
      agent_id: AGENT_ID,
      profile,
      environment: "live",
      name: `${profile} production`,
    };
  }

  it.each([
    ["document_extractor_v1", ["raw:write"]],
    ["bff_service_v1", AGENT_API_KEY_PROFILE_SCOPES.bff_service_v1],
  ] as const)("issues %s with only its server-owned scopes", async (profile, scopes) => {
    const { app, audit } = await buildApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: `/tenants/${TENANT_ID}/agent-keys`,
        headers: { "x-platform-service-auth": PLATFORM_SECRET },
        payload: createPayload(profile),
      });
      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.api_key).toMatch(/^brain_ak_live_/);
      expect(body.scopes).toEqual(scopes);
      const stored = keys.get(body.id as string)!;
      expect(stored.hashed_secret).toBe(hashAgentApiKey(body.api_key as string, PEPPER));
      expect(JSON.stringify(stored)).not.toContain(body.api_key as string);
      expect(audit.events[0]).toMatchObject({ action: "auth.agent_api_key.issued" });
    } finally {
      await app.close();
    }
  });

  it("rejects caller-selected environments and missing platform authentication", async () => {
    const { app } = await buildApp();
    try {
      const wrongEnvironment = await app.inject({
        method: "POST",
        url: `/tenants/${TENANT_ID}/agent-keys`,
        headers: { "x-platform-service-auth": PLATFORM_SECRET },
        payload: { ...createPayload("document_extractor_v1"), environment: "test" },
      });
      expect(wrongEnvironment.statusCode).toBe(400);

      const unauthenticated = await app.inject({
        method: "POST",
        url: `/tenants/${TENANT_ID}/agent-keys`,
        payload: createPayload("document_extractor_v1"),
      });
      expect(unauthenticated.statusCode).toBe(401);
      expect(keys.size).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("rejects a scoped bearer principal crossing its tenant boundary", async () => {
    const { app } = await buildApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: `/tenants/${OTHER_TENANT_ID}/agent-keys`,
        headers: { "x-test-principal-tenant": TENANT_ID },
        payload: createPayload("document_extractor_v1"),
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("auth_tenant_mismatch");
      expect(keys.size).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("lists metadata without plaintext, rotates atomically, and revokes", async () => {
    const { app } = await buildApp();
    try {
      const headers = { "x-platform-service-auth": PLATFORM_SECRET };
      const issued = await app.inject({
        method: "POST",
        url: `/tenants/${TENANT_ID}/agent-keys`,
        headers,
        payload: createPayload("document_extractor_v1"),
      });
      const first = issued.json();

      const listed = await app.inject({
        method: "GET",
        url: `/tenants/${TENANT_ID}/agent-keys`,
        headers,
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().keys[0]).not.toHaveProperty("api_key");

      const rotated = await app.inject({
        method: "POST",
        url: `/agent-keys/${first.id as string}/rotate`,
        headers,
      });
      expect(rotated.statusCode).toBe(201);
      const replacement = rotated.json();
      expect(replacement.id).not.toBe(first.id);
      expect(replacement.rotated_from_id).toBe(first.id);
      expect(keys.get(first.id as string)?.revoked_at).not.toBeNull();

      const revoked = await app.inject({
        method: "DELETE",
        url: `/agent-keys/${replacement.id as string}`,
        headers,
      });
      expect(revoked.statusCode).toBe(204);
      expect(keys.get(replacement.id as string)?.revoked_at).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it("replays the same one-time plaintext for a matching Idempotency-Key", async () => {
    const { app, audit } = await buildApp();
    try {
      const request = {
        method: "POST" as const,
        url: `/tenants/${TENANT_ID}/agent-keys`,
        headers: {
          "x-platform-service-auth": PLATFORM_SECRET,
          "idempotency-key": "issue-extractor-once",
        },
        payload: createPayload("document_extractor_v1"),
      };
      const first = await app.inject(request);
      const replay = await app.inject(request);
      expect(first.statusCode).toBe(201);
      expect(replay.statusCode).toBe(201);
      expect(replay.headers["idempotent-replay"]).toBe("true");
      expect(replay.json()).toEqual(first.json());
      expect(keys.size).toBe(1);
      expect(audit.events).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});
