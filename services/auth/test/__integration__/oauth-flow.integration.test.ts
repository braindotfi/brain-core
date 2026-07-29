/**
 * Full Phase 2a increment 3 code flow against a real schema, driven through
 * real brain_auth / brain_resolver role connections (matching
 * human-auth.integration.test.ts's pattern) so RLS actually enforces tenant
 * isolation the way it does in production.
 *
 * Requires DATABASE_URL (owner, for the harness/seeding) and the per-role
 * URLs DATABASE_URL_AUTH (brain_auth) and DATABASE_URL_RESOLVER
 * (brain_resolver). Skips cleanly when any is absent.
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
  verifyWithKey,
  withTenantScope,
} from "@brain/shared";
import { scopesForAgentRole } from "@brain/internal-agents";
import { McpAuthVerifier, type OnchainScopeChecker } from "@brain/mcp";
import { buildAuthHarness, type AuthHarness } from "./harness.js";
import { buildAuthApp } from "../../src/server.js";
import { ResolverUserCredentialReader } from "../../src/credentials.js";
import { deriveCodeChallenge } from "../../src/pkce.js";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME, deriveCsrfToken } from "../../src/session.js";
import { sha256Hex } from "../../src/token.js";

const DB_URL = process.env.DATABASE_URL;
const AUTH_URL = process.env.DATABASE_URL_AUTH;
const RESOLVER_URL = process.env.DATABASE_URL_RESOLVER;
const DESCRIBE =
  DB_URL !== undefined && AUTH_URL !== undefined && RESOLVER_URL !== undefined
    ? describe
    : describe.skip;

const COOKIE_SECRET = "integration-test-cookie-secret";
const SIGN_SECRET = "integration-test-hs256-sign-secret-do-not-use-in-prod";
const ISSUER = "https://auth.brain.fi";
const AUDIENCE = "brain-api";
const MCP_RESOURCE = "https://mcp.brain.fi";
const REDIRECT_URI = "https://example.test/cb";
const PASSWORD = "a-fine-integration-password";

let h: AuthHarness | null = null;
let authPool: Pool | null = null;
let resolverPool: Pool | null = null;
let app: FastifyInstance | null = null;
// Captured (not discarded inline) so tests can assert on .events -- an
// inline `new InMemoryAuditEmitter()` with nothing keeping a reference is
// exactly how the grant_revoked/rotation_race audit gap shipped unnoticed
// (Opus review, Phase 2b).
let oauthAudit: InMemoryAuditEmitter | null = null;

const onchainRegistry = new Map<string, string>();
const fakeOnchain: OnchainScopeChecker = {
  async getOnchainScopeHash(agentId: string) {
    return onchainRegistry.get(agentId) ?? null;
  },
};

let signer: JwtSigner;
let jwtVerifyOpts: {
  jwksUrl: string;
  issuer: string;
  audience: string;
  clockToleranceSeconds: number;
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

async function seedNonAdminMember(input: {
  tenantId: string;
  memberId: string;
  email: string;
  role: "approver" | "viewer";
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
       VALUES ($1, $2, $3, $3, $4, 'active', 1000000)`,
    [input.tenantId, input.memberId, input.email, input.role],
  );
}

async function seedAgent(input: {
  tenantId: string;
  agentId: string;
  role: string;
  scopeHash: Buffer;
  state?: string;
}): Promise<void> {
  if (h === null) throw new Error("harness not built");
  await h.pool.query(
    `INSERT INTO agents (id, tenant_id, kind, role, display_name, scope_hash, state)
       VALUES ($1, $2, 'external', $3, 'Test Agent', $4, $5)`,
    [input.agentId, input.tenantId, input.role, input.scopeHash, input.state ?? "active"],
  );
}

async function seedOauthClient(clientId: string, redirectUris: string[]): Promise<void> {
  if (h === null) throw new Error("harness not built");
  await h.pool.query(
    `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, grant_types, response_types)
       VALUES ($1, 'Test Client', $2::text[], ARRAY['authorization_code', 'refresh_token'], ARRAY['code'])`,
    [clientId, redirectUris],
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

/** Full password login via a fresh CSRF carrier; returns the session cookie value. */
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

interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  codeChallenge: string;
  resource?: string;
}

function authorizeQuery(p: AuthorizeParams): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    scope: p.scope,
    state: p.state,
    code_challenge: p.codeChallenge,
    code_challenge_method: "S256",
  });
  if (p.resource !== undefined) params.set("resource", p.resource);
  return params.toString();
}

DESCRIBE(
  "OAuth core full flow (requires DATABASE_URL, DATABASE_URL_AUTH, DATABASE_URL_RESOLVER)",
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

      // The OAuth core's own token-signing key: a plain HS256 secret is
      // enough (verified below via the raw secret, jwt.test.ts's pattern) --
      // it is a SEPARATE key from buildAuthApp's own signKey below, which is
      // asymmetric only because /.well-known/jwks.json requires a public
      // half (toPublicJwk throws for kty=oct). Real deploys use one shared
      // AUTH_SIGN_KEY for both (main.ts); decoupling them here is a test-only
      // simplification -- buildAuthApp's JWKS route is not under test here.
      const oauthSignKey = {
        kty: "oct",
        k: Buffer.from(SIGN_SECRET).toString("base64url"),
        alg: "HS256",
      };
      signer = new JwtSigner({
        issuer: ISSUER,
        audience: AUDIENCE,
        key: oauthSignKey,
        algorithm: "HS256",
      });
      jwtVerifyOpts = {
        jwksUrl: "unused://",
        issuer: ISSUER,
        audience: AUDIENCE,
        clockToleranceSeconds: 5,
      };
      const jwksSignKey = await generateSignKeyJwk();

      // buildAuthApp (not a raw Fastify() + manual route registration): the
      // most faithful integration test also exercises the REAL urlencoded
      // body parser (server.ts) that a live form submit depends on, not just
      // the route logic in isolation.
      app = await buildAuthApp({
        issuer: ISSUER,
        signKey: JSON.stringify(jwksSignKey),
        serviceName: "brain-auth",
        serviceVersion: "0.0.0-dev",
        commit: "test",
        logger: false,
        humanAuth: {
          authPool,
          credentialReader: new ResolverUserCredentialReader(resolverPool),
          cookieSecret: COOKIE_SECRET,
          audit: new InMemoryAuditEmitter(),
          deliverForgotPasswordEmail: async () => true,
        },
        oauthCore: {
          authPool,
          resolverPool,
          cookieSecret: COOKIE_SECRET,
          audit: (oauthAudit = new InMemoryAuditEmitter()),
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

    it("full flow: login, GET /authorize renders consent, POST consent issues a code, POST /token mints a JWT accepted by JwtVerifier and McpAuthVerifier", async () => {
      if (h === null || app === null) return;
      const tenantId = newTenantId();
      const memberId = newUserId();
      const agentId = newAgentId();
      const clientId = "oacl_full_flow_test";
      const email = `admin-${memberId}@example.test`;
      const registeredScopes = scopesForAgentRole("payment");
      const scopeHash = scopeHashBuffer(registeredScopes);

      await seedTenant(tenantId);
      await seedAdmin({ tenantId, memberId, email });
      await seedAgent({ tenantId, agentId, role: "payment", scopeHash });
      await seedOauthClient(clientId, [REDIRECT_URI]);
      onchainRegistry.set(agentId, scopeHash.toString("hex"));

      const sessionCookie = await login(app, email);

      const codeVerifier = "a".repeat(43);
      const codeChallenge = deriveCodeChallenge(codeVerifier);
      const requestedScope = "ledger:read wiki:read execution:propose";

      const authorizeRes = await app.inject({
        method: "GET",
        url: `/authorize?${authorizeQuery({
          clientId,
          redirectUri: REDIRECT_URI,
          scope: requestedScope,
          state: "xyz",
          codeChallenge,
          resource: MCP_RESOURCE,
        })}`,
        headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}` },
      });
      expect(authorizeRes.statusCode).toBe(200);
      expect(authorizeRes.body).toContain(`value="${agentId}"`);
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
          ["client_id", clientId],
          ["redirect_uri", REDIRECT_URI],
          ["response_type", "code"],
          ["scope", requestedScope],
          ["state", "xyz"],
          ["code_challenge", codeChallenge],
          ["code_challenge_method", "S256"],
          ["resource", MCP_RESOURCE],
          ["agent_id", agentId],
          ["decision", "allow"],
          ["scope_selected", "ledger:read"],
          ["scope_selected", "wiki:read"],
          ["scope_selected", "execution:propose"],
        ]),
      });
      expect(consentRes.statusCode).toBe(302);
      const location = consentRes.headers.location as string;
      expect(location.startsWith(REDIRECT_URI)).toBe(true);
      const redirectUrl = new URL(location);
      expect(redirectUrl.searchParams.get("state")).toBe("xyz");
      const code = redirectUrl.searchParams.get("code");
      if (code === null) throw new Error("no code in redirect");

      const tokenRes = await app.inject({
        method: "POST",
        url: "/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: formBody([
          ["grant_type", "authorization_code"],
          ["code", code],
          ["redirect_uri", REDIRECT_URI],
          ["client_id", clientId],
          ["code_verifier", codeVerifier],
        ]),
      });
      expect(tokenRes.statusCode).toBe(200);
      expect(tokenRes.headers["cache-control"]).toBe("no-store");
      const tokenBody = tokenRes.json() as {
        access_token: string;
        token_type: string;
        scope: string;
      };
      expect(tokenBody.token_type).toBe("Bearer");
      expect(tokenBody.scope.split(" ").sort()).toEqual(
        ["ledger:read", "wiki:read", "execution:propose"].sort(),
      );

      // Verified exactly like a SIWX-minted token would be: same JwtVerifier
      // path, and (RFC 8707) an array aud that still verifies against the
      // plain "brain-api" audience.
      const principal = await verifyWithKey(
        tokenBody.access_token,
        async () => new TextEncoder().encode(SIGN_SECRET),
        jwtVerifyOpts,
      );
      expect(principal.type).toBe("agent");
      expect(principal.id).toBe(agentId);
      expect(principal.tenantId).toBe(tenantId);
      expect([...principal.scopes].sort()).toEqual(
        ["ledger:read", "wiki:read", "execution:propose"].sort(),
      );

      // Cross-service: the same token is accepted exactly like a SIWX one by
      // the real McpAuthVerifier (services/mcp/src/auth.ts).
      const mcpVerifier = new McpAuthVerifier(h.pool, fakeOnchain);
      const mcpResult = await mcpVerifier.verify(principal);
      expect(mcpResult.agent.id).toBe(agentId);
      expect(mcpResult.agent.state).toBe("active");

      // Replay: the SAME code presented again must hard-reject.
      const replayRes = await app.inject({
        method: "POST",
        url: "/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: formBody([
          ["grant_type", "authorization_code"],
          ["code", code],
          ["redirect_uri", REDIRECT_URI],
          ["client_id", clientId],
          ["code_verifier", codeVerifier],
        ]),
      });
      expect(replayRes.statusCode).toBe(400);
      expect(replayRes.json()).toEqual({ error: "invalid_grant" });
    });

    it("wrong code_verifier rejects at /token", async () => {
      if (h === null || app === null) return;
      const tenantId = newTenantId();
      const memberId = newUserId();
      const agentId = newAgentId();
      const clientId = "oacl_wrong_verifier_test";
      const email = `admin-${memberId}@example.test`;
      const registeredScopes = scopesForAgentRole("payment");
      const scopeHash = scopeHashBuffer(registeredScopes);

      await seedTenant(tenantId);
      await seedAdmin({ tenantId, memberId, email });
      await seedAgent({ tenantId, agentId, role: "payment", scopeHash });
      await seedOauthClient(clientId, [REDIRECT_URI]);
      onchainRegistry.set(agentId, scopeHash.toString("hex"));

      const sessionCookie = await login(app, email);
      const codeVerifier = "a".repeat(43);
      const codeChallenge = deriveCodeChallenge(codeVerifier);

      const authorizeRes = await app.inject({
        method: "GET",
        url: `/authorize?${authorizeQuery({
          clientId,
          redirectUri: REDIRECT_URI,
          scope: "ledger:read",
          state: "s1",
          codeChallenge,
        })}`,
        headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}` },
      });
      const consentCsrf = authorizeRes.body.match(/name="csrf" value="([^"]*)"/)?.[1]!;

      const consentRes = await app.inject({
        method: "POST",
        url: "/authorize/consent",
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        payload: formBody([
          ["csrf", consentCsrf],
          ["client_id", clientId],
          ["redirect_uri", REDIRECT_URI],
          ["response_type", "code"],
          ["scope", "ledger:read"],
          ["state", "s1"],
          ["code_challenge", codeChallenge],
          ["code_challenge_method", "S256"],
          ["resource", ""],
          ["agent_id", agentId],
          ["decision", "allow"],
          ["scope_selected", "ledger:read"],
        ]),
      });
      const code = new URL(consentRes.headers.location as string).searchParams.get("code")!;

      const tokenRes = await app.inject({
        method: "POST",
        url: "/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: formBody([
          ["grant_type", "authorization_code"],
          ["code", code],
          ["redirect_uri", REDIRECT_URI],
          ["client_id", clientId],
          ["code_verifier", "b".repeat(43)],
        ]),
      });
      expect(tokenRes.statusCode).toBe(400);
      expect(tokenRes.json()).toEqual({ error: "invalid_grant" });
    });

    it("an expired code rejects at /token", async () => {
      if (h === null || app === null || authPool === null) return;
      const tenantId = newTenantId();
      const memberId = newUserId();
      const agentId = newAgentId();
      const clientId = "oacl_expiry_test";
      const email = `admin-${memberId}@example.test`;
      const scopeHash = scopeHashBuffer(scopesForAgentRole("payment"));
      await seedTenant(tenantId);
      await seedAdmin({ tenantId, memberId, email });
      await seedAgent({ tenantId, agentId, role: "payment", scopeHash });
      await seedOauthClient(clientId, [REDIRECT_URI]);

      const codeVerifier = "a".repeat(43);
      const codeChallenge = deriveCodeChallenge(codeVerifier);
      const codeHash = sha256Hex(`raw-code-${agentId}`);

      await withTenantScope(authPool, tenantId, async (client) => {
        await client.query(
          `INSERT INTO oauth_consent_grants (id, tenant_id, client_id, agent_id, member_id, scopes, scope_hash_at_grant)
           VALUES ('ogr_expiry_test', $1, $2, $3, $4, ARRAY['ledger:read']::text[], $5)`,
          [tenantId, clientId, agentId, memberId, scopeHash],
        );
        await client.query(
          `INSERT INTO oauth_authorization_codes
           (code_hash, client_id, tenant_id, agent_id, member_id, grant_id, scopes,
            redirect_uri, code_challenge, code_challenge_method, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'ogr_expiry_test', ARRAY['ledger:read']::text[], $6, $7, 'S256',
                 now() - interval '5 seconds')`,
          [codeHash, clientId, tenantId, agentId, memberId, REDIRECT_URI, codeChallenge],
        );
      });

      const tokenRes = await app.inject({
        method: "POST",
        url: "/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: formBody([
          ["grant_type", "authorization_code"],
          ["code", `raw-code-${agentId}`],
          ["redirect_uri", REDIRECT_URI],
          ["client_id", clientId],
          ["code_verifier", codeVerifier],
        ]),
      });
      expect(tokenRes.statusCode).toBe(400);
      expect(tokenRes.json()).toEqual({ error: "invalid_grant" });
    });

    it("code single-use is proven with two concurrent exchanges: exactly one wins", async () => {
      if (h === null || app === null) return;
      const tenantId = newTenantId();
      const memberId = newUserId();
      const agentId = newAgentId();
      const clientId = "oacl_concurrent_test";
      const email = `admin-${memberId}@example.test`;
      const scopeHash = scopeHashBuffer(scopesForAgentRole("payment"));
      await seedTenant(tenantId);
      await seedAdmin({ tenantId, memberId, email });
      await seedAgent({ tenantId, agentId, role: "payment", scopeHash });
      await seedOauthClient(clientId, [REDIRECT_URI]);
      onchainRegistry.set(agentId, scopeHash.toString("hex"));

      const sessionCookie = await login(app, email);
      const codeVerifier = "a".repeat(43);
      const codeChallenge = deriveCodeChallenge(codeVerifier);

      const authorizeRes = await app.inject({
        method: "GET",
        url: `/authorize?${authorizeQuery({
          clientId,
          redirectUri: REDIRECT_URI,
          scope: "ledger:read",
          state: "concurrent",
          codeChallenge,
        })}`,
        headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}` },
      });
      const consentCsrf = authorizeRes.body.match(/name="csrf" value="([^"]*)"/)?.[1]!;
      const consentRes = await app.inject({
        method: "POST",
        url: "/authorize/consent",
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        payload: formBody([
          ["csrf", consentCsrf],
          ["client_id", clientId],
          ["redirect_uri", REDIRECT_URI],
          ["response_type", "code"],
          ["scope", "ledger:read"],
          ["state", "concurrent"],
          ["code_challenge", codeChallenge],
          ["code_challenge_method", "S256"],
          ["resource", ""],
          ["agent_id", agentId],
          ["decision", "allow"],
          ["scope_selected", "ledger:read"],
        ]),
      });
      const code = new URL(consentRes.headers.location as string).searchParams.get("code")!;

      const exchangeOnce = () =>
        app!.inject({
          method: "POST",
          url: "/token",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          payload: formBody([
            ["grant_type", "authorization_code"],
            ["code", code],
            ["redirect_uri", REDIRECT_URI],
            ["client_id", clientId],
            ["code_verifier", codeVerifier],
          ]),
        });

      const [first, second] = await Promise.all([exchangeOnce(), exchangeOnce()]);
      const statuses = [first.statusCode, second.statusCode].sort();
      expect(statuses).toEqual([200, 400]);
    });

    it("scope-hash mismatch rejects at consent", async () => {
      if (h === null || app === null) return;
      const tenantId = newTenantId();
      const memberId = newUserId();
      const agentId = newAgentId();
      const clientId = "oacl_mismatch_test";
      const email = `admin-${memberId}@example.test`;
      // Deliberately wrong: neither the canonical hash for "payment" nor
      // registered on-chain (not added to onchainRegistry).
      const wrongHash = Buffer.from("00".repeat(32), "hex");
      await seedTenant(tenantId);
      await seedAdmin({ tenantId, memberId, email });
      await seedAgent({ tenantId, agentId, role: "payment", scopeHash: wrongHash });
      await seedOauthClient(clientId, [REDIRECT_URI]);

      const sessionCookie = await login(app, email);
      const codeVerifier = "a".repeat(43);
      const codeChallenge = deriveCodeChallenge(codeVerifier);

      // GET /authorize itself does not on-chain-check per-agent (display-time
      // only, see routes/oauth.ts), so the agent still appears in the consent
      // list; the hard reject happens at POST /authorize/consent.
      const consentRes = await app.inject({
        method: "POST",
        url: "/authorize/consent",
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        payload: formBody([
          ["csrf", await sessionCsrf(app, sessionCookie)],
          ["client_id", clientId],
          ["redirect_uri", REDIRECT_URI],
          ["response_type", "code"],
          ["scope", "ledger:read"],
          ["state", "s1"],
          ["code_challenge", codeChallenge],
          ["code_challenge_method", "S256"],
          ["resource", ""],
          ["agent_id", agentId],
          ["decision", "allow"],
          ["scope_selected", "ledger:read"],
        ]),
      });
      expect(consentRes.statusCode).toBe(409);
      expect(consentRes.body).toContain("scope attestation could not be verified");
    });

    it("a non-admin member cannot consent (redirects access_denied)", async () => {
      if (h === null || app === null) return;
      const tenantId = newTenantId();
      const memberId = newUserId();
      const clientId = "oacl_nonadmin_test";
      const email = `viewer-${memberId}@example.test`;
      await seedTenant(tenantId);
      await seedNonAdminMember({ tenantId, memberId, email, role: "viewer" });
      await seedOauthClient(clientId, [REDIRECT_URI]);

      const sessionCookie = await login(app!, email);
      const codeChallenge = deriveCodeChallenge("a".repeat(43));

      const authorizeRes = await app!.inject({
        method: "GET",
        url: `/authorize?${authorizeQuery({
          clientId,
          redirectUri: REDIRECT_URI,
          scope: "ledger:read",
          state: "denied-state",
          codeChallenge,
        })}`,
        headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}` },
      });
      expect(authorizeRes.statusCode).toBe(302);
      const url = new URL(authorizeRes.headers.location as string);
      expect(url.searchParams.get("error")).toBe("access_denied");
      expect(url.searchParams.get("state")).toBe("denied-state");
    });

    it("a cross-tenant agent selection returns not-found", async () => {
      if (h === null || app === null) return;
      const tenantA = newTenantId();
      const tenantB = newTenantId();
      const memberId = newUserId();
      const otherAgentId = newAgentId();
      const clientId = "oacl_cross_tenant_test";
      const email = `admin-${memberId}@example.test`;
      await seedTenant(tenantA);
      await seedTenant(tenantB);
      await seedAdmin({ tenantId: tenantA, memberId, email });
      await seedAgent({
        tenantId: tenantB,
        agentId: otherAgentId,
        role: "payment",
        scopeHash: scopeHashBuffer(scopesForAgentRole("payment")),
      });
      await seedOauthClient(clientId, [REDIRECT_URI]);

      const sessionCookie = await login(app!, email);
      const codeChallenge = deriveCodeChallenge("a".repeat(43));

      const consentRes = await app!.inject({
        method: "POST",
        url: "/authorize/consent",
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        payload: formBody([
          ["csrf", await sessionCsrf(app!, sessionCookie)],
          ["client_id", clientId],
          ["redirect_uri", REDIRECT_URI],
          ["response_type", "code"],
          ["scope", "ledger:read"],
          ["state", "s1"],
          ["code_challenge", codeChallenge],
          ["code_challenge_method", "S256"],
          ["resource", ""],
          ["agent_id", otherAgentId],
          ["decision", "allow"],
          ["scope_selected", "ledger:read"],
        ]),
      });
      expect(consentRes.statusCode).toBe(404);
    });

    it("RLS: brain_auth scoped to tenant B cannot read tenant A's authorization code row", async () => {
      if (h === null || app === null || authPool === null) return;
      const tenantA = newTenantId();
      const tenantB = newTenantId();
      const memberId = newUserId();
      const agentId = newAgentId();
      const clientId = "oacl_rls_test";
      const email = `admin-${memberId}@example.test`;
      const scopeHash = scopeHashBuffer(scopesForAgentRole("payment"));
      await seedTenant(tenantA);
      await seedTenant(tenantB);
      await seedAdmin({ tenantId: tenantA, memberId, email });
      await seedAgent({ tenantId: tenantA, agentId, role: "payment", scopeHash });
      await seedOauthClient(clientId, [REDIRECT_URI]);
      onchainRegistry.set(agentId, scopeHash.toString("hex"));

      const sessionCookie = await login(app, email);
      const codeVerifier = "a".repeat(43);
      const codeChallenge = deriveCodeChallenge(codeVerifier);

      const authorizeRes = await app.inject({
        method: "GET",
        url: `/authorize?${authorizeQuery({
          clientId,
          redirectUri: REDIRECT_URI,
          scope: "ledger:read",
          state: "rls-state",
          codeChallenge,
        })}`,
        headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}` },
      });
      const consentCsrf = authorizeRes.body.match(/name="csrf" value="([^"]*)"/)?.[1]!;
      const consentRes = await app.inject({
        method: "POST",
        url: "/authorize/consent",
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        payload: formBody([
          ["csrf", consentCsrf],
          ["client_id", clientId],
          ["redirect_uri", REDIRECT_URI],
          ["response_type", "code"],
          ["scope", "ledger:read"],
          ["state", "rls-state"],
          ["code_challenge", codeChallenge],
          ["code_challenge_method", "S256"],
          ["resource", ""],
          ["agent_id", agentId],
          ["decision", "allow"],
          ["scope_selected", "ledger:read"],
        ]),
      });
      const code = new URL(consentRes.headers.location as string).searchParams.get("code")!;
      const codeHash = sha256Hex(code);

      const rowsUnderTenantB = await withTenantScope(authPool, tenantB, (client) =>
        client.query<{ code_hash: string }>(
          "SELECT code_hash FROM oauth_authorization_codes WHERE code_hash = $1",
          [codeHash],
        ),
      );
      expect(rowsUnderTenantB.rows.length).toBe(0);

      const rowsUnderTenantA = await withTenantScope(authPool, tenantA, (client) =>
        client.query<{ code_hash: string }>(
          "SELECT code_hash FROM oauth_authorization_codes WHERE code_hash = $1",
          [codeHash],
        ),
      );
      expect(rowsUnderTenantA.rows.length).toBe(1);
    });

    // ---- Phase 2b: refresh grant, rotation, reuse detection, revocation ----

    it("refresh rotation returns a fresh refresh token; the old one then fails", async () => {
      if (h === null || app === null) return;
      const seeded = await seedRefreshFixture("oacl_refresh_rotate_test");
      const first = await obtainRefreshToken(seeded);

      const refreshRes = await app.inject({
        method: "POST",
        url: "/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: formBody([
          ["grant_type", "refresh_token"],
          ["refresh_token", first.refreshToken],
          ["client_id", seeded.clientId],
        ]),
      });
      expect(refreshRes.statusCode).toBe(200);
      const refreshBody = refreshRes.json() as { access_token: string; refresh_token: string };
      expect(refreshBody.refresh_token).not.toBe(first.refreshToken);

      const replayOldRes = await app.inject({
        method: "POST",
        url: "/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: formBody([
          ["grant_type", "refresh_token"],
          ["refresh_token", first.refreshToken],
          ["client_id", seeded.clientId],
        ]),
      });
      expect(replayOldRes.statusCode).toBe(400);
      expect(replayOldRes.json()).toEqual({ error: "invalid_grant" });
    });

    it("presenting a rotated (already-used) refresh token revokes the whole family and audits it flagged", async () => {
      if (h === null || app === null || oauthAudit === null) return;
      const seeded = await seedRefreshFixture("oacl_refresh_reuse_test");
      const first = await obtainRefreshToken(seeded);
      const eventsBefore = oauthAudit.events.length;

      const rotateRes = await app.inject({
        method: "POST",
        url: "/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: formBody([
          ["grant_type", "refresh_token"],
          ["refresh_token", first.refreshToken],
          ["client_id", seeded.clientId],
        ]),
      });
      expect(rotateRes.statusCode).toBe(200);
      const { refresh_token: secondRefreshToken } = rotateRes.json() as { refresh_token: string };

      // Reuse of the already-rotated first token.
      const reuseRes = await app.inject({
        method: "POST",
        url: "/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: formBody([
          ["grant_type", "refresh_token"],
          ["refresh_token", first.refreshToken],
          ["client_id", seeded.clientId],
        ]),
      });
      expect(reuseRes.statusCode).toBe(400);
      expect(reuseRes.json()).toEqual({ error: "invalid_grant" });

      const reusedEvent = oauthAudit.events
        .slice(eventsBefore)
        .find((e) => e.action === "oauth.refresh_token.reused");
      expect(reusedEvent).toBeDefined();
      expect(reusedEvent?.eventType).toBe("flagged");
      expect(reusedEvent?.actor).toBe(seeded.agentId);

      // The reuse detection above must have revoked the WHOLE family,
      // including the second (never-yet-reused) token.
      const secondNowRes = await app.inject({
        method: "POST",
        url: "/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: formBody([
          ["grant_type", "refresh_token"],
          ["refresh_token", secondRefreshToken],
          ["client_id", seeded.clientId],
        ]),
      });
      expect(secondNowRes.statusCode).toBe(400);
      expect(secondNowRes.json()).toEqual({ error: "invalid_grant" });
    });

    it("a revoked consent grant blocks refresh and audits it flagged", async () => {
      if (h === null || app === null || oauthAudit === null) return;
      const seeded = await seedRefreshFixture("oacl_refresh_grant_revoked_test");
      const { refreshToken } = await obtainRefreshToken(seeded);
      const eventsBefore = oauthAudit.events.length;

      await h.pool.query(
        `UPDATE oauth_consent_grants SET revoked_at = now()
           WHERE tenant_id = $1 AND agent_id = $2`,
        [seeded.tenantId, seeded.agentId],
      );

      const refreshRes = await app.inject({
        method: "POST",
        url: "/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: formBody([
          ["grant_type", "refresh_token"],
          ["refresh_token", refreshToken],
          ["client_id", seeded.clientId],
        ]),
      });
      expect(refreshRes.statusCode).toBe(400);
      expect(refreshRes.json()).toEqual({ error: "invalid_grant" });

      const grantRevokedEvent = oauthAudit.events
        .slice(eventsBefore)
        .find((e) => e.action === "oauth.refresh_token.grant_revoked");
      expect(grantRevokedEvent).toBeDefined();
      expect(grantRevokedEvent?.eventType).toBe("flagged");
    });

    it("a quarantined agent blocks refresh and audits it (not flagged)", async () => {
      if (h === null || app === null || oauthAudit === null) return;
      const seeded = await seedRefreshFixture("oacl_refresh_quarantine_test");
      const { refreshToken } = await obtainRefreshToken(seeded);
      const eventsBefore = oauthAudit.events.length;

      await h.pool.query(`UPDATE agents SET state = 'quarantined' WHERE id = $1`, [seeded.agentId]);

      const refreshRes = await app.inject({
        method: "POST",
        url: "/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: formBody([
          ["grant_type", "refresh_token"],
          ["refresh_token", refreshToken],
          ["client_id", seeded.clientId],
        ]),
      });
      expect(refreshRes.statusCode).toBe(400);
      expect(refreshRes.json()).toEqual({ error: "invalid_grant" });

      const agentInactiveEvent = oauthAudit.events
        .slice(eventsBefore)
        .find((e) => e.action === "oauth.refresh_token.agent_inactive");
      expect(agentInactiveEvent).toBeDefined();
      expect(agentInactiveEvent?.eventType).not.toBe("flagged");
    });

    it("a rotated on-chain scope hash blocks refresh and audits it flagged", async () => {
      if (h === null || app === null || oauthAudit === null) return;
      const seeded = await seedRefreshFixture("oacl_refresh_drift_test");
      const { refreshToken } = await obtainRefreshToken(seeded);
      const eventsBefore = oauthAudit.events.length;

      // Simulate the tenant rotating the agent's on-chain scope set after
      // consent: agents.scope_hash now differs from oauth_consent_grants'
      // scope_hash_at_grant.
      const rotatedHash = scopeHashBuffer(scopesForAgentRole("viewer"));
      await h.pool.query(`UPDATE agents SET scope_hash = $1 WHERE id = $2`, [
        rotatedHash,
        seeded.agentId,
      ]);

      const refreshRes = await app.inject({
        method: "POST",
        url: "/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: formBody([
          ["grant_type", "refresh_token"],
          ["refresh_token", refreshToken],
          ["client_id", seeded.clientId],
        ]),
      });
      expect(refreshRes.statusCode).toBe(400);
      expect(refreshRes.json()).toEqual({ error: "invalid_grant" });

      const driftEvent = oauthAudit.events
        .slice(eventsBefore)
        .find((e) => e.action === "oauth.refresh.scope_hash_drift");
      expect(driftEvent).toBeDefined();
      expect(driftEvent?.eventType).toBe("flagged");
    });

    it("a refresh request's scope param widening beyond the stored scopes is rejected with invalid_scope", async () => {
      if (h === null || app === null) return;
      const seeded = await seedRefreshFixture("oacl_refresh_widen_test");
      const { refreshToken } = await obtainRefreshToken(seeded);

      const refreshRes = await app.inject({
        method: "POST",
        url: "/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: formBody([
          ["grant_type", "refresh_token"],
          ["refresh_token", refreshToken],
          ["client_id", seeded.clientId],
          // obtainRefreshToken only ever grants "ledger:read" -- requesting
          // an additional scope here must be rejected outright, not silently
          // narrowed.
          ["scope", "ledger:read wiki:read"],
        ]),
      });
      expect(refreshRes.statusCode).toBe(400);
      expect(refreshRes.json()).toEqual({ error: "invalid_scope" });
    });

    it("a client not registered for refresh_token gets an access token only, and its refresh grant is rejected", async () => {
      if (h === null || app === null) return;
      const tenantId = newTenantId();
      const memberId = newUserId();
      const agentId = newAgentId();
      const clientId = "oacl_code_only_test";
      const email = `admin-${memberId}@example.test`;
      const scopeHash = scopeHashBuffer(scopesForAgentRole("payment"));
      await seedTenant(tenantId);
      await seedAdmin({ tenantId, memberId, email });
      await seedAgent({ tenantId, agentId, role: "payment", scopeHash });
      // Deliberately authorization_code only -- mirrors an operator
      // registering a client for a short-lived supervised integration
      // (Opus review, Phase 2b).
      await h!.pool.query(
        `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, grant_types, response_types)
           VALUES ($1, 'Code-Only Client', $2::text[], ARRAY['authorization_code'], ARRAY['code'])`,
        [clientId, [REDIRECT_URI]],
      );
      onchainRegistry.set(agentId, scopeHash.toString("hex"));
      const sessionCookie = await login(app, email);

      const codeVerifier = "a".repeat(43);
      const codeChallenge = deriveCodeChallenge(codeVerifier);
      const authorizeRes = await app.inject({
        method: "GET",
        url: `/authorize?${authorizeQuery({
          clientId,
          redirectUri: REDIRECT_URI,
          scope: "ledger:read",
          state: "s1",
          codeChallenge,
        })}`,
        headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}` },
      });
      const consentCsrf = authorizeRes.body.match(/name="csrf" value="([^"]*)"/)?.[1]!;
      const consentRes = await app.inject({
        method: "POST",
        url: "/authorize/consent",
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        payload: formBody([
          ["csrf", consentCsrf],
          ["client_id", clientId],
          ["redirect_uri", REDIRECT_URI],
          ["response_type", "code"],
          ["scope", "ledger:read"],
          ["state", "s1"],
          ["code_challenge", codeChallenge],
          ["code_challenge_method", "S256"],
          ["resource", ""],
          ["agent_id", agentId],
          ["decision", "allow"],
          ["scope_selected", "ledger:read"],
        ]),
      });
      const code = new URL(consentRes.headers.location as string).searchParams.get("code")!;

      const tokenRes = await app.inject({
        method: "POST",
        url: "/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: formBody([
          ["grant_type", "authorization_code"],
          ["code", code],
          ["redirect_uri", REDIRECT_URI],
          ["client_id", clientId],
          ["code_verifier", codeVerifier],
        ]),
      });
      expect(tokenRes.statusCode).toBe(200);
      const tokenBody = tokenRes.json() as { access_token: string; refresh_token?: string };
      expect(tokenBody.access_token).toBeTruthy();
      expect(tokenBody.refresh_token).toBeUndefined();

      // Even a forged refresh_token grant against this client is rejected
      // before any token lookup -- unauthorized_client, not invalid_grant.
      const refreshRes = await app.inject({
        method: "POST",
        url: "/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: formBody([
          ["grant_type", "refresh_token"],
          ["refresh_token", "anything"],
          ["client_id", clientId],
        ]),
      });
      expect(refreshRes.statusCode).toBe(400);
      expect(refreshRes.json()).toEqual({ error: "unauthorized_client" });
    });

    it("POST /revoke always returns 200 with an empty body, including for a token that never existed", async () => {
      if (h === null || app === null) return;
      const seeded = await seedRefreshFixture("oacl_revoke_test");
      const { refreshToken } = await obtainRefreshToken(seeded);

      const neverExistedRes = await app.inject({
        method: "POST",
        url: "/revoke",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: formBody([
          ["token", "this-token-never-existed"],
          ["client_id", seeded.clientId],
        ]),
      });
      expect(neverExistedRes.statusCode).toBe(200);
      expect(neverExistedRes.body).toBe("");

      const revokeRes = await app.inject({
        method: "POST",
        url: "/revoke",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: formBody([
          ["token", refreshToken],
          ["client_id", seeded.clientId],
        ]),
      });
      expect(revokeRes.statusCode).toBe(200);
      expect(revokeRes.body).toBe("");

      // Idempotent: revoking the same (already-revoked) token again is still 200.
      const revokeAgainRes = await app.inject({
        method: "POST",
        url: "/revoke",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: formBody([
          ["token", refreshToken],
          ["client_id", seeded.clientId],
        ]),
      });
      expect(revokeAgainRes.statusCode).toBe(200);
      expect(revokeAgainRes.body).toBe("");

      // And the revoked token is now unusable for refresh.
      const refreshRes = await app.inject({
        method: "POST",
        url: "/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: formBody([
          ["grant_type", "refresh_token"],
          ["refresh_token", refreshToken],
          ["client_id", seeded.clientId],
        ]),
      });
      expect(refreshRes.statusCode).toBe(400);
      expect(refreshRes.json()).toEqual({ error: "invalid_grant" });
    });
  },
);

interface RefreshFixture {
  tenantId: string;
  agentId: string;
  clientId: string;
  sessionCookie: string;
}

/** Seeds a tenant + admin + payment agent + OAuth client and logs in, for the Phase 2b refresh tests. */
async function seedRefreshFixture(clientId: string): Promise<RefreshFixture> {
  if (h === null || app === null) throw new Error("harness not built");
  const tenantId = newTenantId();
  const memberId = newUserId();
  const agentId = newAgentId();
  const email = `admin-${memberId}@example.test`;
  const scopeHash = scopeHashBuffer(scopesForAgentRole("payment"));
  await seedTenant(tenantId);
  await seedAdmin({ tenantId, memberId, email });
  await seedAgent({ tenantId, agentId, role: "payment", scopeHash });
  await seedOauthClient(clientId, [REDIRECT_URI]);
  onchainRegistry.set(agentId, scopeHash.toString("hex"));
  const sessionCookie = await login(app, email);
  return { tenantId, agentId, clientId, sessionCookie };
}

/** Full authorization_code exchange, returning the minted refresh_token (and access_token) -- the fixture the Phase 2b refresh tests build on. */
async function obtainRefreshToken(
  fixture: RefreshFixture,
): Promise<{ accessToken: string; refreshToken: string }> {
  if (app === null) throw new Error("app not built");
  const codeVerifier = "a".repeat(43);
  const codeChallenge = deriveCodeChallenge(codeVerifier);
  const scope = "ledger:read";

  const authorizeRes = await app.inject({
    method: "GET",
    url: `/authorize?${authorizeQuery({
      clientId: fixture.clientId,
      redirectUri: REDIRECT_URI,
      scope,
      state: "s1",
      codeChallenge,
    })}`,
    headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.sessionCookie}` },
  });
  const consentCsrf = authorizeRes.body.match(/name="csrf" value="([^"]*)"/)?.[1];
  if (consentCsrf === undefined) throw new Error("no consent csrf");

  const consentRes = await app.inject({
    method: "POST",
    url: "/authorize/consent",
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${fixture.sessionCookie}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    payload: formBody([
      ["csrf", consentCsrf],
      ["client_id", fixture.clientId],
      ["redirect_uri", REDIRECT_URI],
      ["response_type", "code"],
      ["scope", scope],
      ["state", "s1"],
      ["code_challenge", codeChallenge],
      ["code_challenge_method", "S256"],
      ["resource", ""],
      ["agent_id", fixture.agentId],
      ["decision", "allow"],
      ["scope_selected", scope],
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
      ["client_id", fixture.clientId],
      ["code_verifier", codeVerifier],
    ]),
  });
  if (tokenRes.statusCode !== 200) {
    throw new Error(`code exchange failed: ${tokenRes.statusCode} ${tokenRes.body}`);
  }
  const tokenBody = tokenRes.json() as { access_token: string; refresh_token: string };
  return { accessToken: tokenBody.access_token, refreshToken: tokenBody.refresh_token };
}

/**
 * Derives the session-cookie-bound CSRF token directly, mirroring
 * routes/oauth.ts's own `deriveCsrfToken(secret, sessionCookieValue)` call --
 * no HTTP round trip needed since the token is a pure function of the
 * already-known session cookie value and cookie secret.
 */
async function sessionCsrf(_fastify: FastifyInstance, sessionCookie: string): Promise<string> {
  return deriveCsrfToken(COOKIE_SECRET, sessionCookie);
}
