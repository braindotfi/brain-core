import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import {
  ACCESS_TOKEN_REQUESTED_TYPE,
  AGENT_API_KEY_SUBJECT_TOKEN_TYPE,
  InMemoryAuditEmitter,
  JwtSigner,
  TOKEN_EXCHANGE_GRANT_TYPE,
  generateAgentApiKey,
  generateSignKeyJwk,
  hashAgentApiKey,
  newAgentId,
  newTenantId,
} from "@brain/shared";
import { buildAuthApp } from "../../src/server.js";
import { buildAuthHarness, type AuthHarness } from "./harness.js";

const DB_URL = process.env.DATABASE_URL;
const AUTH_URL = process.env.DATABASE_URL_AUTH;
const RESOLVER_URL = process.env.DATABASE_URL_RESOLVER;
const DESCRIBE =
  DB_URL !== undefined && AUTH_URL !== undefined && RESOLVER_URL !== undefined
    ? describe
    : describe.skip;

const RESOURCE = "https://api.brain.fi/";
const PEPPER = "agent-key-integration-pepper";

let harness: AuthHarness | null = null;
let authPool: Pool | null = null;
let resolverPool: Pool | null = null;
let app: FastifyInstance | null = null;
const tenantId = newTenantId();
const agentId = newAgentId();
const generated = generateAgentApiKey("live");

function scopedRolePool(url: string, schema: string): Pool {
  const pool = new Pool({ connectionString: url, max: 3 });
  pool.on("connect", (client) => {
    void client.query(`SET search_path TO ${schema}, public`);
  });
  return pool;
}

DESCRIBE("agent API key exchange with production DB roles", () => {
  beforeAll(async () => {
    harness = await buildAuthHarness();
    if (harness === null) return;

    await harness.pool.query(
      `GRANT USAGE ON SCHEMA ${harness.schema} TO brain_auth, brain_resolver`,
    );
    await harness.pool.query(
      `GRANT SELECT ON ${harness.schema}.tenants, ${harness.schema}.agents,
          ${harness.schema}.agent_api_keys TO brain_auth`,
    );
    await harness.pool.query(
      `GRANT UPDATE (last_used_at) ON ${harness.schema}.agent_api_keys TO brain_auth`,
    );
    await harness.pool.query(
      `GRANT SELECT (id, tenant_id) ON ${harness.schema}.agent_api_keys TO brain_resolver`,
    );
    await harness.pool.query("INSERT INTO tenants (id, kind) VALUES ($1, 'production')", [
      tenantId,
    ]);
    await harness.pool.query(
      `INSERT INTO agents (id, tenant_id, kind, role, display_name, state)
       VALUES ($1, $2, 'internal', 'document_extractor', 'Document Extractor', 'active')`,
      [agentId, tenantId],
    );
    await harness.pool.query(
      `INSERT INTO agent_api_keys
        (id, tenant_id, agent_id, profile, environment, scopes, hashed_secret,
         key_prefix, key_last4, name, expires_at)
       VALUES ($1, $2, $3, 'document_extractor_v1', 'live', ARRAY['raw:write'],
         $4, 'brain_ak_live_', $5, 'integration extractor', now() + interval '90 days')`,
      [
        generated.id,
        tenantId,
        agentId,
        hashAgentApiKey(generated.plaintext, PEPPER),
        generated.last4,
      ],
    );

    authPool = scopedRolePool(AUTH_URL!, harness.schema);
    resolverPool = scopedRolePool(RESOLVER_URL!, harness.schema);
    const signKey = await generateSignKeyJwk();
    const signer = new JwtSigner({
      issuer: "https://auth.brain.fi",
      audience: "brain-api",
      key: signKey,
      algorithm: signKey.alg ?? "RS256",
    });
    const audit = new InMemoryAuditEmitter();
    app = await buildAuthApp({
      issuer: "https://auth.brain.fi",
      signKey: JSON.stringify(signKey),
      serviceName: "brain-auth",
      serviceVersion: "integration",
      commit: "integration",
      logger: false,
      oauthCore: {
        authPool,
        resolverPool,
        cookieSecret: "integration-cookie-secret",
        audit,
        signer,
        onchain: { getOnchainScopeHash: async () => null },
        authAudience: "brain-api",
        mcpPublicResourceUrl: "https://mcp.brain.fi",
        agentKeyExchange: {
          authPool,
          resolverPool,
          audit,
          signer,
          pepper: PEPPER,
          environment: "live",
          resource: RESOURCE,
        },
      },
    });
  }, 60_000);

  afterAll(async () => {
    if (app !== null) await app.close();
    if (authPool !== null) await authPool.end();
    if (resolverPool !== null) await resolverPool.end();
    if (harness !== null) await harness.cleanup();
  });

  async function exchange(secret: string) {
    if (app === null) throw new Error("app not built");
    return app.inject({
      method: "POST",
      url: "/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
        subject_token: secret,
        subject_token_type: AGENT_API_KEY_SUBJECT_TOKEN_TYPE,
        requested_token_type: ACCESS_TOKEN_REQUESTED_TYPE,
        resource: RESOURCE,
      }).toString(),
    });
  }

  it("exchanges through brain_resolver and tenant-scoped brain_auth, then records use", async () => {
    if (harness === null) return;
    const response = await exchange(generated.plaintext);
    expect(response.statusCode).toBe(200);
    expect(response.json()).not.toHaveProperty("refresh_token");
    const { rows } = await harness.pool.query<{ last_used_at: Date | null }>(
      "SELECT last_used_at FROM agent_api_keys WHERE id = $1",
      [generated.id],
    );
    expect(rows[0]?.last_used_at).toBeInstanceOf(Date);
  });

  it("rejects a revoked credential immediately", async () => {
    if (harness === null) return;
    await harness.pool.query("UPDATE agent_api_keys SET revoked_at = now() WHERE id = $1", [
      generated.id,
    ]);
    const response = await exchange(generated.plaintext);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_request" });
  });
});
