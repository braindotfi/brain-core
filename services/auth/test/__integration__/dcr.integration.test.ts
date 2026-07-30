/**
 * Phase 3 RFC 7591 Dynamic Client Registration, integration-level.
 *
 * Exact harness pattern as oauth-flow.integration.test.ts (same file, same
 * skip gate): requires DATABASE_URL (owner, for the harness/seeding) and the
 * per-role URLs DATABASE_URL_AUTH (brain_auth) and DATABASE_URL_RESOLVER
 * (brain_resolver). Skips cleanly when any is absent -- which is the case in
 * this environment (no live Postgres was stood up for this work). These
 * tests were confirmed to load and register correctly under vitest's skip
 * gate; they were NEVER executed against a live Postgres.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import {
  computeAgentScopeHash,
  generateSignKeyJwk,
  hashPassword,
  InMemoryAuditEmitter,
  JwtSigner,
  newAgentId,
  newTenantId,
  newUserId,
} from "@brain/shared";
import { scopesForAgentRole } from "@brain/internal-agents";
import type { OnchainScopeChecker } from "@brain/mcp";
import { buildAuthHarness, type AuthHarness } from "./harness.js";
import { buildAuthApp } from "../../src/server.js";
import { ResolverUserCredentialReader } from "../../src/credentials.js";
import { deriveCodeChallenge } from "../../src/pkce.js";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "../../src/session.js";
import { REGISTER_RATE_LIMIT } from "../../src/routes/register.js";

const DB_URL = process.env.DATABASE_URL;
const AUTH_URL = process.env.DATABASE_URL_AUTH;
const RESOLVER_URL = process.env.DATABASE_URL_RESOLVER;
const DESCRIBE =
  DB_URL !== undefined && AUTH_URL !== undefined && RESOLVER_URL !== undefined
    ? describe
    : describe.skip;

const COOKIE_SECRET = "dcr-integration-test-cookie-secret";
const SIGN_SECRET = "dcr-integration-test-hs256-sign-secret-do-not-use-in-prod";
const ISSUER = "https://auth.brain.fi";
const AUDIENCE = "brain-api";
const MCP_RESOURCE = "https://mcp.brain.fi";
const REDIRECT_URI = "https://dcr-client.example.test/cb";
const PASSWORD = "a-fine-dcr-integration-password";

let h: AuthHarness | null = null;
let authPool: Pool | null = null;
let resolverPool: Pool | null = null;
let app: FastifyInstance | null = null;

const onchainRegistry = new Map<string, string>();
const fakeOnchain: OnchainScopeChecker = {
  async getOnchainScopeHash(agentId: string) {
    return onchainRegistry.get(agentId) ?? null;
  },
};

function scopedPool(url: string, schema: string): Pool {
  const pool = new Pool({ connectionString: url, max: 3 });
  pool.on("connect", (c) => {
    void c.query(`SET search_path TO ${schema}, public`);
  });
  return pool;
}

function scopeHashBuffer(scopes: readonly string[]): Buffer {
  return Buffer.from(computeAgentScopeHash(scopes).slice(2), "hex");
}

async function seedTenant(tenantId: string): Promise<void> {
  if (h === null) throw new Error("harness not built");
  await h.pool.query("INSERT INTO tenants (id) VALUES ($1)", [tenantId]);
}

async function seedAdmin(input: {
  tenantId: string;
  memberId: string;
  email: string;
}): Promise<void> {
  if (h === null) throw new Error("harness not built");
  const passwordHash = await hashPassword(PASSWORD);
  await h.pool.query(
    `INSERT INTO users (id, tenant_id, email, role, password_hash, status, email_verified_at)
       VALUES ($1, $2, $3, 'owner', $4, 'active', now())`,
    [input.memberId, input.tenantId, input.email, passwordHash],
  );
  await h.pool.query(
    `INSERT INTO members (tenant_id, id, email, display_name, role, status, per_item_limit_cents)
       VALUES ($1, $2, $3, $3, 'admin', 'active', 1000000)`,
    [input.tenantId, input.memberId, input.email],
  );
}

async function seedAgent(input: {
  tenantId: string;
  agentId: string;
  role: string;
  scopeHash: Buffer;
}): Promise<void> {
  if (h === null) throw new Error("harness not built");
  await h.pool.query(
    `INSERT INTO agents (id, tenant_id, kind, role, display_name, scope_hash, state)
       VALUES ($1, $2, 'external', $3, 'Test Agent', $4, 'active')`,
    [input.agentId, input.tenantId, input.role, input.scopeHash],
  );
}

function extractCookie(header: string | string[] | undefined, name: string): string | undefined {
  const headers = Array.isArray(header) ? header : header !== undefined ? [header] : [];
  for (const v of headers)
    if (v.startsWith(`${name}=`)) return v.split(";")[0]!.slice(name.length + 1);
  return undefined;
}

function formBody(fields: Array<[string, string]>): string {
  const params = new URLSearchParams();
  for (const [k, v] of fields) params.append(k, v);
  return params.toString();
}

async function login(fastify: FastifyInstance, email: string): Promise<string> {
  const getRes = await fastify.inject({ method: "GET", url: "/login" });
  const carrier = extractCookie(getRes.headers["set-cookie"], CSRF_COOKIE_NAME);
  if (carrier === undefined) throw new Error("no csrf carrier");
  const csrfMatch = getRes.body.match(/name="csrf" value="([^"]*)"/);
  if (csrfMatch === null) throw new Error("no csrf field");

  const postRes = await fastify.inject({
    method: "POST",
    url: "/login",
    headers: {
      cookie: `${CSRF_COOKIE_NAME}=${carrier}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    payload: formBody([
      ["email", email],
      ["password", PASSWORD],
      ["csrf", csrfMatch[1]!],
    ]),
  });
  if (postRes.statusCode !== 200) {
    throw new Error(`login failed: ${postRes.statusCode} ${postRes.body}`);
  }
  const session = extractCookie(postRes.headers["set-cookie"], SESSION_COOKIE_NAME);
  if (session === undefined) throw new Error("no session cookie");
  return session;
}

function authorizeQuery(p: {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  codeChallenge: string;
}): string {
  return new URLSearchParams({
    response_type: "code",
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    scope: p.scope,
    state: p.state,
    code_challenge: p.codeChallenge,
    code_challenge_method: "S256",
  }).toString();
}

interface RegisteredClient {
  client_id: string;
  client_id_issued_at: number;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
  client_name: string;
}

async function register(
  fastify: FastifyInstance,
  body: Record<string, unknown>,
  ip = "203.0.113.9",
): Promise<{ statusCode: number; json: () => unknown }> {
  return fastify.inject({
    method: "POST",
    url: "/register",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    payload: JSON.stringify(body),
  });
}

DESCRIBE(
  "Dynamic Client Registration (requires DATABASE_URL, DATABASE_URL_AUTH, DATABASE_URL_RESOLVER)",
  () => {
    beforeAll(async () => {
      h = await buildAuthHarness();
      if (h === null) return;
      await h.pool.query(`GRANT USAGE ON SCHEMA ${h.schema} TO brain_auth, brain_resolver`);
      await h.pool.query(
        `GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA ${h.schema} TO brain_auth`,
      );
      await h.pool.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${h.schema} TO brain_resolver`);

      authPool = scopedPool(AUTH_URL!, h.schema);
      resolverPool = scopedPool(RESOLVER_URL!, h.schema);

      const oauthSignKey = {
        kty: "oct",
        k: Buffer.from(SIGN_SECRET).toString("base64url"),
        alg: "HS256",
      };
      const signer = new JwtSigner({
        issuer: ISSUER,
        audience: AUDIENCE,
        key: oauthSignKey,
        algorithm: "HS256",
      });
      const jwksSignKey = await generateSignKeyJwk();

      app = await buildAuthApp({
        issuer: ISSUER,
        signKey: JSON.stringify(jwksSignKey),
        serviceName: "brain-auth",
        serviceVersion: "0.0.0-dev",
        commit: "test",
        logger: false,
        humanAuth: {
          authPool: authPool!,
          credentialReader: new ResolverUserCredentialReader(resolverPool!),
          cookieSecret: COOKIE_SECRET,
          audit: new InMemoryAuditEmitter(),
          deliverForgotPasswordEmail: async () => true,
        },
        oauthCore: {
          authPool: authPool!,
          resolverPool: resolverPool!,
          cookieSecret: COOKIE_SECRET,
          audit: new InMemoryAuditEmitter(),
          signer,
          onchain: fakeOnchain,
          authAudience: AUDIENCE,
          mcpPublicResourceUrl: MCP_RESOURCE,
        },
      });
    }, 60_000);

    afterAll(async () => {
      if (app !== null) await app.close();
      if (authPool !== null) await authPool.end();
      if (resolverPool !== null) await resolverPool.end();
      if (h !== null) await h.cleanup();
    });

    it("full DCR round trip: registers, then completes authorize -> consent -> token", async () => {
      if (h === null || app === null) return;

      const regRes = await register(app, {
        redirect_uris: [REDIRECT_URI],
        grant_types: ["authorization_code", "refresh_token"],
        client_name: "DCR Round Trip Client",
      });
      expect(regRes.statusCode).toBe(201);
      const client = regRes.json() as RegisteredClient;
      expect(client.client_id).toMatch(/^oacl_/);
      expect(client.token_endpoint_auth_method).toBe("none");
      expect(client.grant_types).toEqual(["authorization_code", "refresh_token"]);

      const tenantId = newTenantId();
      const memberId = newUserId();
      const agentId = newAgentId();
      const email = `admin-${memberId}@example.test`;
      const scopeHash = scopeHashBuffer(scopesForAgentRole("payment"));
      await seedTenant(tenantId);
      await seedAdmin({ tenantId, memberId, email });
      await seedAgent({ tenantId, agentId, role: "payment", scopeHash });
      onchainRegistry.set(agentId, scopeHash.toString("hex"));

      const sessionCookie = await login(app, email);
      const codeVerifier = "a".repeat(43);
      const codeChallenge = deriveCodeChallenge(codeVerifier);

      const authorizeRes = await app.inject({
        method: "GET",
        url: `/authorize?${authorizeQuery({
          clientId: client.client_id,
          redirectUri: REDIRECT_URI,
          scope: "ledger:read",
          state: "dcr-state",
          codeChallenge,
        })}`,
        headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}` },
      });
      expect(authorizeRes.statusCode).toBe(200);
      const consentCsrf = authorizeRes.body.match(/name="csrf" value="([^"]*)"/)?.[1];
      if (consentCsrf === undefined) throw new Error("no consent csrf");

      const consentRes = await app.inject({
        method: "POST",
        url: "/authorize/consent",
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        payload: formBody([
          ["csrf", consentCsrf],
          ["client_id", client.client_id],
          ["redirect_uri", REDIRECT_URI],
          ["response_type", "code"],
          ["scope", "ledger:read"],
          ["state", "dcr-state"],
          ["code_challenge", codeChallenge],
          ["code_challenge_method", "S256"],
          ["resource", ""],
          ["agent_id", agentId],
          ["decision", "allow"],
          ["scope_selected", "ledger:read"],
        ]),
      });
      expect(consentRes.statusCode).toBe(302);
      const code = new URL(consentRes.headers.location as string).searchParams.get("code");
      if (code === null) throw new Error("no code in redirect");

      const tokenRes = await app.inject({
        method: "POST",
        url: "/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: formBody([
          ["grant_type", "authorization_code"],
          ["code", code],
          ["redirect_uri", REDIRECT_URI],
          ["client_id", client.client_id],
          ["code_verifier", codeVerifier],
        ]),
      });
      expect(tokenRes.statusCode).toBe(200);
      const tokenBody = tokenRes.json() as { access_token: string; refresh_token?: string };
      expect(tokenBody.access_token).toBeTruthy();
      expect(tokenBody.refresh_token).toBeTruthy();
    });

    it(
      "a DCR client registered WITHOUT refresh_token gets an access token but no refresh token, " +
        "and is refused unauthorized_client on refresh -- ties Phase 3 to Phase 2b enforcement",
      async () => {
        if (h === null || app === null) return;

        const regRes = await register(app, {
          redirect_uris: [REDIRECT_URI],
          // grant_types omitted -> defaults to ["authorization_code"] only.
          client_name: "Code-Only DCR Client",
        });
        expect(regRes.statusCode).toBe(201);
        const client = regRes.json() as RegisteredClient;
        expect(client.grant_types).toEqual(["authorization_code"]);

        const tenantId = newTenantId();
        const memberId = newUserId();
        const agentId = newAgentId();
        const email = `admin-${memberId}@example.test`;
        const scopeHash = scopeHashBuffer(scopesForAgentRole("payment"));
        await seedTenant(tenantId);
        await seedAdmin({ tenantId, memberId, email });
        await seedAgent({ tenantId, agentId, role: "payment", scopeHash });
        onchainRegistry.set(agentId, scopeHash.toString("hex"));

        const sessionCookie = await login(app, email);
        const codeVerifier = "b".repeat(43);
        const codeChallenge = deriveCodeChallenge(codeVerifier);

        const authorizeRes = await app.inject({
          method: "GET",
          url: `/authorize?${authorizeQuery({
            clientId: client.client_id,
            redirectUri: REDIRECT_URI,
            scope: "ledger:read",
            state: "code-only-state",
            codeChallenge,
          })}`,
          headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}` },
        });
        const consentCsrf = authorizeRes.body.match(/name="csrf" value="([^"]*)"/)?.[1];
        if (consentCsrf === undefined) throw new Error("no consent csrf");

        const consentRes = await app.inject({
          method: "POST",
          url: "/authorize/consent",
          headers: {
            cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          payload: formBody([
            ["csrf", consentCsrf],
            ["client_id", client.client_id],
            ["redirect_uri", REDIRECT_URI],
            ["response_type", "code"],
            ["scope", "ledger:read"],
            ["state", "code-only-state"],
            ["code_challenge", codeChallenge],
            ["code_challenge_method", "S256"],
            ["resource", ""],
            ["agent_id", agentId],
            ["decision", "allow"],
            ["scope_selected", "ledger:read"],
          ]),
        });
        const code = new URL(consentRes.headers.location as string).searchParams.get("code");
        if (code === null) throw new Error("no code in redirect");

        const tokenRes = await app.inject({
          method: "POST",
          url: "/token",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          payload: formBody([
            ["grant_type", "authorization_code"],
            ["code", code],
            ["redirect_uri", REDIRECT_URI],
            ["client_id", client.client_id],
            ["code_verifier", codeVerifier],
          ]),
        });
        expect(tokenRes.statusCode).toBe(200);
        const tokenBody = tokenRes.json() as { access_token: string; refresh_token?: string };
        expect(tokenBody.access_token).toBeTruthy();
        expect(tokenBody.refresh_token).toBeUndefined();

        const refreshRes = await app.inject({
          method: "POST",
          url: "/token",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          payload: formBody([
            ["grant_type", "refresh_token"],
            ["refresh_token", "anything"],
            ["client_id", client.client_id],
          ]),
        });
        expect(refreshRes.statusCode).toBe(400);
        expect(refreshRes.json()).toEqual({ error: "unauthorized_client" });
      },
    );

    it(
      `the rate limit trips at the configured threshold (${REGISTER_RATE_LIMIT.max}/${REGISTER_RATE_LIMIT.timeWindow}) ` +
        "and cannot be bypassed by forging additional X-Forwarded-For hops",
      async () => {
        if (h === null || app === null) return;
        // The address Caddy itself actually observed (the rightmost hop --
        // server.ts's trustProxy: 1 trusts exactly one hop, so this is the
        // ONLY value req.ip can resolve to for these requests, regardless of
        // what a caller prepends ahead of it).
        const realIp = "198.51.100.42";

        let last: Awaited<ReturnType<typeof register>> | undefined;
        for (let i = 0; i < REGISTER_RATE_LIMIT.max; i++) {
          last = await register(app, { redirect_uris: [REDIRECT_URI] }, realIp);
        }
        expect(last?.statusCode).toBe(201);

        const overLimit = await register(app, { redirect_uris: [REDIRECT_URI] }, realIp);
        expect(overLimit.statusCode).toBe(429);

        // Opus review, Phase 3 follow-up (finding 5): the previous version of
        // this test proved nothing past this point -- both "a different IP"
        // and an attacker's forged IP are indistinguishable when the test
        // just sets whatever X-Forwarded-For value it likes, so it passed
        // identically under the OLD, spoofable trustProxy: true config. The
        // real property to prove is that a caller CANNOT manufacture a fresh
        // bucket by forging a hop ahead of the one Caddy actually appended:
        // a distinct, per-request LEFTMOST entry in front of the SAME real
        // rightmost IP must still resolve to `realIp` and stay exhausted.
        for (let i = 0; i < 3; i++) {
          const spoofed = await register(
            app,
            { redirect_uris: [REDIRECT_URI] },
            `10.0.0.${i}, ${realIp}`,
          );
          expect(spoofed.statusCode).toBe(429);
        }

        // A genuinely different real client -- a different RIGHTMOST hop,
        // the one thing an attacker sharing no proxy hop with realIp cannot
        // forge -- still gets its own independent bucket.
        const otherReal = await register(app, { redirect_uris: [REDIRECT_URI] }, "198.51.100.99");
        expect(otherReal.statusCode).toBe(201);
      },
    );

    it("a registered-but-never-consented client can obtain nothing", async () => {
      if (h === null || app === null) return;
      const regRes = await register(app, {
        redirect_uris: [REDIRECT_URI],
        grant_types: ["authorization_code", "refresh_token"],
      });
      const client = regRes.json() as RegisteredClient;

      const tokenRes = await app.inject({
        method: "POST",
        url: "/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: formBody([
          ["grant_type", "authorization_code"],
          ["code", "never-issued-code"],
          ["redirect_uri", REDIRECT_URI],
          ["client_id", client.client_id],
          ["code_verifier", "a".repeat(43)],
        ]),
      });
      expect(tokenRes.statusCode).toBe(400);
      expect(tokenRes.json()).toEqual({ error: "invalid_grant" });

      const refreshRes = await app.inject({
        method: "POST",
        url: "/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: formBody([
          ["grant_type", "refresh_token"],
          ["refresh_token", "never-issued-refresh-token"],
          ["client_id", client.client_id],
        ]),
      });
      expect(refreshRes.statusCode).toBe(400);
      expect(refreshRes.json()).toEqual({ error: "invalid_grant" });
    });
  },
);
