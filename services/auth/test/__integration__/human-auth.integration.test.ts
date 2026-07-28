/**
 * Full Path 1 flow against a real schema, driven through real brain_auth /
 * brain_resolver role connections (not the harness owner pool), so RLS
 * actually enforces tenant isolation the way it does in production.
 *
 * Requires DATABASE_URL (owner, for the harness/seeding) and the per-role
 * URLs DATABASE_URL_AUTH (brain_auth) and DATABASE_URL_RESOLVER
 * (brain_resolver), matching the DATABASE_URL_APP convention already used by
 * rls.integration.test.ts. Skips cleanly when any is absent.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import Fastify, { type FastifyInstance } from "fastify";
import { hashPassword, newTenantId, newUserId, InMemoryAuditEmitter } from "@brain/shared";
import { buildAuthHarness, type AuthHarness } from "./harness.js";
import { registerHumanAuthRoutes } from "../../src/routes/human-auth.js";
import { ResolverUserCredentialReader } from "../../src/credentials.js";
import { resolveAuthority } from "../../src/authority.js";
import { newRawToken, sha256Hex } from "../../src/token.js";
import { CSRF_COOKIE_NAME } from "../../src/session.js";

const DB_URL = process.env.DATABASE_URL;
const AUTH_URL = process.env.DATABASE_URL_AUTH;
const RESOLVER_URL = process.env.DATABASE_URL_RESOLVER;
const DESCRIBE =
  DB_URL !== undefined && AUTH_URL !== undefined && RESOLVER_URL !== undefined
    ? describe
    : describe.skip;

const COOKIE_SECRET = "integration-test-cookie-secret";

let h: AuthHarness | null = null;
let authPool: Pool | null = null;
let resolverPool: Pool | null = null;
let app: FastifyInstance | null = null;

function scopedPool(url: string, schema: string): Pool {
  const pool = new Pool({ connectionString: url, max: 3 });
  pool.on("connect", (c) => {
    void c.query(`SET search_path TO ${schema}, public`);
  });
  return pool;
}

async function seedTenant(tenantId: string): Promise<void> {
  if (h === null) throw new Error("harness not built");
  await h.pool.query("INSERT INTO tenants (id) VALUES ($1)", [tenantId]);
}

async function seedFounder(input: {
  tenantId: string;
  userId: string;
  email: string;
  passwordHash: string | null;
  status?: string;
  emailVerifiedAt?: Date | null;
}): Promise<void> {
  if (h === null) throw new Error("harness not built");
  await h.pool.query(
    `INSERT INTO users (id, tenant_id, email, role, password_hash, status, email_verified_at)
       VALUES ($1, $2, $3, 'owner', $4, $5, $6)`,
    [
      input.userId,
      input.tenantId,
      input.email,
      input.passwordHash,
      input.status ?? "active",
      input.emailVerifiedAt ?? null,
    ],
  );
}

async function seedMember(input: {
  tenantId: string;
  memberId: string;
  email: string;
  role: "admin" | "approver" | "viewer";
  status?: "invited" | "active" | "deactivated";
}): Promise<void> {
  if (h === null) throw new Error("harness not built");
  await h.pool.query(
    `INSERT INTO members (tenant_id, id, email, display_name, role, status, per_item_limit_cents)
       VALUES ($1, $2, $3, $3, $4, $5, 1000000)`,
    [input.tenantId, input.memberId, input.email, input.role, input.status ?? "active"],
  );
}

async function seedSetPasswordToken(input: {
  tenantId: string;
  userId: string;
  rawToken: string;
  expiresAt?: Date;
}): Promise<void> {
  if (h === null) throw new Error("harness not built");
  await h.pool.query(
    `INSERT INTO email_verifications (token_hash, user_id, tenant_id, expires_at)
       VALUES ($1, $2, $3, $4)`,
    [
      sha256Hex(input.rawToken),
      input.userId,
      input.tenantId,
      input.expiresAt ?? new Date(Date.now() + 60_000),
    ],
  );
}

function extractCookie(header: string | string[] | undefined, name: string): string | undefined {
  const headers = Array.isArray(header) ? header : header !== undefined ? [header] : [];
  for (const v of headers)
    if (v.startsWith(`${name}=`)) return v.split(";")[0]!.slice(name.length + 1);
  return undefined;
}

async function csrfFor(
  fastify: FastifyInstance,
  path: string,
): Promise<{ carrier: string; token: string }> {
  const res = await fastify.inject({ method: "GET", url: path });
  const carrier = extractCookie(res.headers["set-cookie"], CSRF_COOKIE_NAME);
  if (carrier === undefined) throw new Error("no csrf carrier");
  const match = res.body.match(/name="csrf" value="([^"]*)"/);
  if (match === null) throw new Error("no csrf field");
  return { carrier, token: match[1]! };
}

DESCRIBE(
  "human-auth full flow (requires DATABASE_URL, DATABASE_URL_AUTH, DATABASE_URL_RESOLVER)",
  () => {
    beforeAll(async () => {
      h = await buildAuthHarness();
      if (h === null) return;
      // infra/db-roles.sql's grants target "public"; scope the same footprint to
      // this run's private schema, mirroring rls.integration.test.ts's pattern.
      await h.pool.query(`GRANT USAGE ON SCHEMA ${h.schema} TO brain_auth, brain_resolver`);
      await h.pool.query(
        `GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA ${h.schema} TO brain_auth`,
      );
      await h.pool.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${h.schema} TO brain_resolver`);

      authPool = scopedPool(AUTH_URL!, h.schema);
      resolverPool = scopedPool(RESOLVER_URL!, h.schema);

      app = Fastify({ logger: false });
      await registerHumanAuthRoutes(app, {
        authPool,
        credentialReader: new ResolverUserCredentialReader(resolverPool),
        cookieSecret: COOKIE_SECRET,
        audit: new InMemoryAuditEmitter(),
        deliverForgotPasswordEmail: async () => true,
      });
    }, 60_000);

    afterAll(async () => {
      if (app !== null) await app.close();
      if (authPool !== null) await authPool.end();
      if (resolverPool !== null) await resolverPool.end();
      if (h !== null) await h.cleanup();
    });

    it("full flow: set-password consumes the founder invite, then login succeeds", async () => {
      if (h === null || app === null) return;
      const tenantId = newTenantId();
      const userId = newUserId();
      const rawToken = newRawToken();
      await seedTenant(tenantId);
      await seedFounder({ tenantId, userId, email: "founder@example.test", passwordHash: null });
      await seedSetPasswordToken({ tenantId, userId, rawToken });

      const { carrier, token } = await csrfFor(app, `/set-password?tid=${tenantId}&t=${rawToken}`);
      const setRes = await app.inject({
        method: "POST",
        url: "/set-password",
        headers: { cookie: `${CSRF_COOKIE_NAME}=${carrier}` },
        payload: { tid: tenantId, t: rawToken, password: "a-brand-new-password", csrf: token },
      });
      expect(setRes.statusCode).toBe(303);
      expect(setRes.headers.location).toBe("/login?notice=password_set");

      const { carrier: loginCarrier, token: loginCsrf } = await csrfFor(app, "/login");
      const loginRes = await app.inject({
        method: "POST",
        url: "/login",
        headers: { cookie: `${CSRF_COOKIE_NAME}=${loginCarrier}` },
        payload: {
          email: "founder@example.test",
          password: "a-brand-new-password",
          csrf: loginCsrf,
        },
      });
      expect(loginRes.statusCode).toBe(200);
      expect(loginRes.body).toContain("founder@example.test");
    });

    it("rejects replay of an already-consumed token", async () => {
      if (h === null || app === null) return;
      const tenantId = newTenantId();
      const userId = newUserId();
      const rawToken = newRawToken();
      await seedTenant(tenantId);
      await seedFounder({
        tenantId,
        userId,
        email: `replay-${userId}@example.test`,
        passwordHash: null,
      });
      await seedSetPasswordToken({ tenantId, userId, rawToken });

      const first = await csrfFor(app, `/set-password?tid=${tenantId}&t=${rawToken}`);
      const firstPost = await app.inject({
        method: "POST",
        url: "/set-password",
        headers: { cookie: `${CSRF_COOKIE_NAME}=${first.carrier}` },
        payload: {
          tid: tenantId,
          t: rawToken,
          password: "first-password-value",
          csrf: first.token,
        },
      });
      expect(firstPost.statusCode).toBe(303);

      const replayGet = await app.inject({
        method: "GET",
        url: `/set-password?tid=${tenantId}&t=${rawToken}`,
      });
      expect(replayGet.statusCode).toBe(404);

      const second = await csrfFor(app, "/login");
      const replayPost = await app.inject({
        method: "POST",
        url: "/set-password",
        headers: { cookie: `${CSRF_COOKIE_NAME}=${second.carrier}` },
        payload: {
          tid: tenantId,
          t: rawToken,
          password: "second-password-value",
          csrf: second.token,
        },
      });
      expect(replayPost.statusCode).toBe(404);
    });

    it("a token minted for tenant A returns not-found under tenant B's tid (RLS, not a leak)", async () => {
      if (h === null || app === null) return;
      const tenantA = newTenantId();
      const tenantB = newTenantId();
      const userId = newUserId();
      const rawToken = newRawToken();
      await seedTenant(tenantA);
      await seedTenant(tenantB);
      await seedFounder({
        tenantId: tenantA,
        userId,
        email: `cross-${userId}@example.test`,
        passwordHash: null,
      });
      await seedSetPasswordToken({ tenantId: tenantA, userId, rawToken });

      const res = await app.inject({
        method: "GET",
        url: `/set-password?tid=${tenantB}&t=${rawToken}`,
      });
      expect(res.statusCode).toBe(404);
      expect(res.body).toContain("invalid, expired, or has already been used");

      // Proves it is genuinely RLS (not-found), not merely "no matching hash":
      // the SAME token under its OWN tenant still works.
      const validRes = await app.inject({
        method: "GET",
        url: `/set-password?tid=${tenantA}&t=${rawToken}`,
      });
      expect(validRes.statusCode).toBe(200);
    });

    it("a users.status='pending' user cannot log in", async () => {
      if (h === null || app === null) return;
      const tenantId = newTenantId();
      const userId = newUserId();
      await seedTenant(tenantId);
      await seedFounder({
        tenantId,
        userId,
        email: `pending-${userId}@example.test`,
        passwordHash: await hashPassword("a-fine-password-value"),
        status: "pending",
        emailVerifiedAt: null,
      });

      const { carrier, token } = await csrfFor(app, "/login");
      const res = await app.inject({
        method: "POST",
        url: "/login",
        headers: { cookie: `${CSRF_COOKIE_NAME}=${carrier}` },
        payload: {
          email: `pending-${userId}@example.test`,
          password: "a-fine-password-value",
          csrf: token,
        },
      });
      expect(res.statusCode).toBe(403);
    });

    it("a user with a deactivated members row authenticates but is refused authority", async () => {
      if (h === null || app === null || authPool === null) return;
      const tenantId = newTenantId();
      const userId = newUserId();
      const email = `deactivated-login-${userId}@example.test`;
      await seedTenant(tenantId);
      await seedFounder({
        tenantId,
        userId,
        email,
        passwordHash: await hashPassword("a-fine-password-value"),
        status: "active",
        emailVerifiedAt: new Date(),
      });
      await seedMember({ tenantId, memberId: userId, email, role: "admin", status: "deactivated" });

      const { carrier, token } = await csrfFor(app, "/login");
      const loginRes = await app.inject({
        method: "POST",
        url: "/login",
        headers: { cookie: `${CSRF_COOKIE_NAME}=${carrier}` },
        payload: { email, password: "a-fine-password-value", csrf: token },
      });
      expect(loginRes.statusCode).toBe(200); // authenticates

      const authority = await resolveAuthority(authPool, { tenantId, userId });
      expect(authority).toEqual({ ok: false, reason: "member_inactive" }); // refused authority
    });

    it("resolveAuthority: a deactivated member is refused authority", async () => {
      if (h === null || authPool === null) return;
      const tenantId = newTenantId();
      const memberId = newUserId();
      await seedTenant(tenantId);
      await seedMember({
        tenantId,
        memberId,
        email: `deactivated-${memberId}@example.test`,
        role: "admin",
        status: "deactivated",
      });
      const result = await resolveAuthority(authPool, { tenantId, userId: memberId });
      expect(result).toEqual({ ok: false, reason: "member_inactive" });
    });

    it("resolveAuthority: no members row is refused", async () => {
      if (h === null || authPool === null) return;
      const tenantId = newTenantId();
      await seedTenant(tenantId);
      const result = await resolveAuthority(authPool, { tenantId, userId: newUserId() });
      expect(result).toEqual({ ok: false, reason: "member_missing" });
    });

    it("resolveAuthority: an active admin member is granted authority", async () => {
      if (h === null || authPool === null) return;
      const tenantId = newTenantId();
      const memberId = newUserId();
      await seedTenant(tenantId);
      await seedMember({
        tenantId,
        memberId,
        email: `admin-${memberId}@example.test`,
        role: "admin",
        status: "active",
      });
      const result = await resolveAuthority(authPool, { tenantId, userId: memberId });
      expect(result).toEqual({ ok: true, grant: { tenantId, memberId } });
    });

    it("resolveAuthority: a non-admin active member is refused", async () => {
      if (h === null || authPool === null) return;
      const tenantId = newTenantId();
      const memberId = newUserId();
      await seedTenant(tenantId);
      await seedMember({
        tenantId,
        memberId,
        email: `viewer-${memberId}@example.test`,
        role: "viewer",
        status: "active",
      });
      const result = await resolveAuthority(authPool, { tenantId, userId: memberId });
      expect(result).toEqual({ ok: false, reason: "not_admin" });
    });
  },
);
