/**
 * Raw integration-test harness.
 *
 * Requires a live Postgres reachable via DATABASE_URL. Tests skip if the env
 * var is not set (local runs without `docker compose up`; unconfigured CI
 * jobs). A happy CI path sets DATABASE_URL to the docker compose or
 * postgres service URL.
 *
 * The harness:
 *   - Creates a fresh per-run schema so parallel test files don't collide.
 *   - Runs the Brain migration runner against that schema.
 *   - Mints JWTs with an ephemeral keypair; wires the JwtVerifier to the same key.
 *   - Constructs an app with in-memory blob + in-memory audit emitter.
 */

import { createHash, createHmac } from "node:crypto";
import { Client, Pool } from "pg";
import Fastify from "fastify";
import {
  InMemoryAuditEmitter,
  InMemoryIdempotencyStore,
  MemoryBlobAdapter,
  JwtVerifier,
  newTenantId,
  newTokenId,
  newUserId,
  verifyWithKey,
  type Principal,
} from "@brain/shared";
import { SignJWT, exportJWK, generateKeyPair, type KeyLike } from "jose";
import { buildRawApp } from "../server.js";
import { applyAll, discoverMigrations } from "../../../../tools/migrate/src/index.js";

/**
 * Fixed test secret standing in for BRAIN_AGENTS_INBOUND_SECRET. Exported so
 * integration tests can prove (and disprove) the cross-tenant parsed
 * writeback trust predicate against the same value the harness wires in.
 */
export const CROSS_TENANT_SERVICE_SECRET = "test-cross-tenant-service-secret";

/**
 * Sign a raw request body with the same HMAC construction the api uses to
 * verify X-Brain-Service-Auth (see services/raw/src/routes/parsed.ts and
 * services/agents/brain_agents/auth.py's expected_signature). Tests must
 * sign the EXACT bytes they POST as the body.
 */
export function signCrossTenantServiceAuth(rawBody: string): string {
  return (
    "sha256=" + createHmac("sha256", CROSS_TENANT_SERVICE_SECRET).update(rawBody).digest("hex")
  );
}

export interface Harness {
  url: string;
  schema: string;
  pool: Pool;
  blob: MemoryBlobAdapter;
  audit: InMemoryAuditEmitter;
  app: Awaited<ReturnType<typeof buildRawApp>>;
  signToken: (claims: {
    tenantId: string;
    scopes: string[];
    principalType?: "user" | "agent" | "api_partner";
    expiresInSeconds?: number;
  }) => Promise<{ token: string; principal: Principal }>;
  cleanup: () => Promise<void>;
}

/**
 * Boot the harness. Returns null if DATABASE_URL is absent (tests should
 * check and skip).
 */
export async function buildHarness(): Promise<Harness | null> {
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl === undefined || dbUrl === "") return null;

  const schema = `brain_test_${createHash("sha1")
    .update(String(process.pid) + String(Date.now()))
    .digest("hex")
    .slice(0, 12)}`;

  // Create + enter schema on a throwaway client.
  const bootstrap = new Client({ connectionString: dbUrl });
  await bootstrap.connect();
  await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await bootstrap.end();

  // Pool scoped to the schema.
  const pool = new Pool({
    connectionString: dbUrl,
    max: 5,
    application_name: `brain-test-${schema}`,
  });
  pool.on("connect", (c) => {
    void c.query(`SET search_path TO ${schema}, public`);
  });

  // Apply migrations.
  const migClient = await pool.connect();
  try {
    await migClient.query(`SET search_path TO ${schema}, public`);
    const discovered = await discoverMigrations(findRepoRoot());
    await applyAll(migClient as unknown as Parameters<typeof applyAll>[0], discovered, {
      appliedBy: "integration-test",
    });
  } finally {
    migClient.release();
  }

  // Ephemeral signing keypair.
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const verifier = new JwtVerifier({
    jwksUrl: "https://auth.brain.fi/.well-known/jwks.json", // unused — we inject the key
    issuer: "https://auth.brain.fi",
    audience: "brain-api",
    clockToleranceSeconds: 5,
  });
  // Monkey-patch verify to use the local key. Keeps the harness hermetic.
  verifier.verify = async (token) =>
    verifyWithKey(token, async () => publicKey as KeyLike, {
      jwksUrl: "",
      issuer: "https://auth.brain.fi",
      audience: "brain-api",
      clockToleranceSeconds: 5,
    });

  const blob = new MemoryBlobAdapter();
  const audit = new InMemoryAuditEmitter();
  const logger = Fastify().log;

  const app = await buildRawApp({
    deps: { pool, blob, audit },
    jwtVerifier: verifier,
    idempotencyStore: new InMemoryIdempotencyStore(),
    plaidVerify: { keyResolver: async () => ({}) as never },
    resolveWebhookTenant: async () => "tnt_NOT_USED",
    logger,
    crossTenantServiceSecret: CROSS_TENANT_SERVICE_SECRET,
  });

  async function signToken(claims: {
    tenantId: string;
    scopes: string[];
    principalType?: "user" | "agent" | "api_partner";
    expiresInSeconds?: number;
  }): Promise<{ token: string; principal: Principal }> {
    const type = claims.principalType ?? "user";
    const sub =
      type === "user"
        ? newUserId()
        : type === "agent"
          ? `agent_${newTokenId().slice(6)}`
          : `partner_${newTokenId().slice(6)}`;
    const jti = newTokenId();
    const exp = Math.floor(Date.now() / 1000) + (claims.expiresInSeconds ?? 300);

    const token = await new SignJWT({
      sub,
      tenant_id: claims.tenantId,
      principal_type: type,
      scopes: claims.scopes,
    })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer("https://auth.brain.fi")
      .setAudience("brain-api")
      .setIssuedAt()
      .setExpirationTime(exp)
      .setJti(jti)
      .sign(privateKey);

    return {
      token,
      principal: {
        id: sub,
        type,
        tenantId: claims.tenantId,
        scopes: claims.scopes as unknown as Principal["scopes"],
        tokenId: jti,
        expiresAt: exp,
      },
    };
  }

  async function cleanup(): Promise<void> {
    await app.close();
    await pool.end();
    const done = new Client({ connectionString: dbUrl });
    await done.connect();
    await done.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await done.end();
  }

  // Keep an unused import / signature lint-quiet.
  void newTenantId;
  void exportJWK;

  return { url: dbUrl, schema, pool, blob, audit, app, signToken, cleanup };
}

function findRepoRoot(): string {
  // Integration tests run from services/raw — repo root is two levels up.
  return new URL("../../../..", import.meta.url).pathname;
}
