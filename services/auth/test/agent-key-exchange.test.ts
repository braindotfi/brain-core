import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  ACCESS_TOKEN_REQUESTED_TYPE,
  AGENT_API_KEY_PROFILE_SCOPES,
  AGENT_API_KEY_SUBJECT_TOKEN_TYPE,
  InMemoryAuditEmitter,
  JwtSigner,
  TOKEN_EXCHANGE_GRANT_TYPE,
  generateAgentApiKey,
  generateSignKeyJwk,
  hashAgentApiKey,
  type Scope,
} from "@brain/shared";
import { buildAuthApp } from "../src/server.js";

const TENANT_ID = "tnt_00000000010000000000000000";
const AGENT_ID = "agent_00000000020000000000000001";
const RESOURCE = "https://api.brain.fi/";
const PEPPER = "agent-key-test-pepper";

interface MutableRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  profile: "document_extractor_v1" | "bff_service_v1";
  environment: "test" | "live";
  scopes: string[];
  hashed_secret: string;
  expires_at: string;
  revoked_at: string | null;
  agent_state: string;
  agent_kind: string;
}

function fakePools(row: MutableRow) {
  let touches = 0;
  const client = {
    query: async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (sql.startsWith("SELECT set_config")) return { rows: [], rowCount: 1 };
      if (sql.includes("FROM agent_api_keys k")) return { rows: [row], rowCount: 1 };
      if (sql.includes("UPDATE agent_api_keys SET last_used_at")) {
        touches += 1;
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected auth query: ${sql}`);
    },
    release: () => undefined,
  };
  return {
    authPool: { connect: async () => client } as unknown as Pool,
    resolverPool: {
      query: async (sql: string, values: unknown[]) => {
        if (!sql.includes("FROM agent_api_keys")) throw new Error(`unexpected query: ${sql}`);
        return values[0] === row.id
          ? { rows: [{ tenant_id: row.tenant_id }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      },
    } as unknown as Pool,
    touches: () => touches,
  };
}

function form(secret: string, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
    subject_token: secret,
    subject_token_type: AGENT_API_KEY_SUBJECT_TOKEN_TYPE,
    requested_token_type: ACCESS_TOKEN_REQUESTED_TYPE,
    resource: RESOURCE,
    ...overrides,
  };
}

function decodeClaims(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  if (payload === undefined) throw new Error("JWT payload missing");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("RFC 8693 agent API key exchange", () => {
  let app: FastifyInstance;
  let secret: string;
  let row: MutableRow;
  let touches: () => number;
  let audit: InMemoryAuditEmitter;

  beforeEach(async () => {
    const generated = generateAgentApiKey("live");
    secret = generated.plaintext;
    row = {
      id: generated.id,
      tenant_id: TENANT_ID,
      agent_id: AGENT_ID,
      profile: "document_extractor_v1",
      environment: "live",
      scopes: ["raw:write"],
      hashed_secret: hashAgentApiKey(secret, PEPPER),
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      revoked_at: null,
      agent_state: "active",
      agent_kind: "internal",
    };
    const pools = fakePools(row);
    touches = pools.touches;
    audit = new InMemoryAuditEmitter();
    const signKey = await generateSignKeyJwk();
    const signer = new JwtSigner({
      issuer: "https://auth.brain.fi",
      audience: "brain-api",
      key: signKey,
      algorithm: signKey.alg ?? "RS256",
    });
    app = await buildAuthApp({
      issuer: "https://auth.brain.fi",
      signKey: JSON.stringify(signKey),
      serviceName: "brain-auth",
      serviceVersion: "test",
      commit: "test",
      logger: false,
      oauthCore: {
        authPool: pools.authPool,
        resolverPool: pools.resolverPool,
        cookieSecret: "test-cookie-secret",
        audit,
        signer,
        onchain: { getOnchainScopeHash: async () => null },
        authAudience: "brain-api",
        mcpPublicResourceUrl: "https://mcp.brain.fi",
        agentKeyExchange: {
          authPool: pools.authPool,
          resolverPool: pools.resolverPool,
          audit,
          signer,
          pepper: PEPPER,
          environment: "live",
          resource: RESOURCE,
        },
      },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  async function exchange(values: Record<string, string>) {
    return app.inject({
      method: "POST",
      url: "/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams(values).toString(),
    });
  }

  it("mints a five-minute, API-audience JWT with credential attribution and no refresh token", async () => {
    const response = await exchange(form(secret));
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers.pragma).toBe("no-cache");
    const body = response.json();
    expect(body).toMatchObject({
      issued_token_type: ACCESS_TOKEN_REQUESTED_TYPE,
      token_type: "Bearer",
      expires_in: 300,
      scope: "raw:write",
    });
    expect(body).not.toHaveProperty("refresh_token");
    const claims = decodeClaims(body.access_token as string);
    expect(claims).toMatchObject({
      sub: AGENT_ID,
      tenant_id: TENANT_ID,
      principal_type: "agent",
      scopes: ["raw:write"],
      aud: RESOURCE,
      credential_id: row.id,
    });
    expect((claims.exp as number) - (claims.iat as number)).toBe(300);
    expect(touches()).toBe(1);
    expect(audit.events[0]).toMatchObject({
      action: "oauth.agent_api_key.exchanged",
      actor: AGENT_ID,
      inputs: { credential_id: row.id, profile: "document_extractor_v1" },
    });
  });

  it("binds the BFF profile to the exact shared service scope set", async () => {
    row.profile = "bff_service_v1";
    row.scopes = [...AGENT_API_KEY_PROFILE_SCOPES.bff_service_v1];
    const response = await exchange(form(secret));
    expect(response.statusCode).toBe(200);
    const claims = decodeClaims(response.json().access_token as string);
    expect(claims.scopes).toEqual(AGENT_API_KEY_PROFILE_SCOPES.bff_service_v1);
  });

  it("allows scope narrowing but rejects widening", async () => {
    row.profile = "bff_service_v1";
    row.scopes = [...AGENT_API_KEY_PROFILE_SCOPES.bff_service_v1];
    const narrowed = await exchange(form(secret, { scope: "ledger:read audit:read" }));
    expect(narrowed.statusCode).toBe(200);
    expect(decodeClaims(narrowed.json().access_token as string).scopes).toEqual([
      "ledger:read",
      "audit:read",
    ] satisfies Scope[]);

    const widened = await exchange(form(secret, { scope: "payment_intent:approve" }));
    expect(widened.statusCode).toBe(400);
    expect(widened.json()).toEqual({ error: "invalid_scope" });
  });

  it.each([
    ["revoked", () => (row.revoked_at = new Date().toISOString())],
    ["expired", () => (row.expires_at = new Date(Date.now() - 1_000).toISOString())],
    ["inactive agent", () => (row.agent_state = "quarantined")],
    ["external agent", () => (row.agent_kind = "external")],
    ["tampered scopes", () => row.scopes.push("ledger:read")],
    ["wrong digest", () => (row.hashed_secret = "00".repeat(32))],
  ])("rejects a %s credential without touching last_used_at", async (_name, mutate) => {
    mutate();
    const response = await exchange(form(secret));
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_request" });
    expect(touches()).toBe(0);
  });

  it("requires the exact resource indicator", async () => {
    const response = await exchange(form(secret, { resource: "https://mcp.brain.fi" }));
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_target" });
    expect(touches()).toBe(0);
  });
});
