import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { hashPassword, newTenantId, newUserId, InMemoryAuditEmitter } from "@brain/shared";
import { registerHumanAuthRoutes } from "../src/routes/human-auth.js";
import type { UserCredentialReader, AuthUserCredential } from "../src/credentials.js";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "../src/session.js";

const COOKIE_SECRET = "test-as-cookie-secret-do-not-use-in-prod";

interface EmailVerificationRow {
  token_hash: string;
  user_id: string;
  tenant_id: string;
  expires_at: Date;
  consumed_at: Date | null;
}

/** Minimal fake pool mirroring services/api/src/production-tenancy/routes.test.ts's pattern. */
function fakeAuthPool() {
  const tokens = new Map<string, EmailVerificationRow>();
  const users = new Map<
    string,
    { password_hash: string | null; status: string; email_verified_at: Date | null }
  >();
  const calls: Array<{ sql: string; values?: unknown[] }> = [];

  const client = {
    query: vi.fn((sql: string, values?: unknown[]) => {
      calls.push(values === undefined ? { sql } : { sql, values });
      if (
        sql === "BEGIN" ||
        sql === "COMMIT" ||
        sql === "ROLLBACK" ||
        sql.startsWith("SELECT set_config")
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (sql.includes("INSERT INTO email_verifications")) {
        const [tokenHash, userId, tenantId, expiresAt] = values as [string, string, string, Date];
        tokens.set(tokenHash, {
          token_hash: tokenHash,
          user_id: userId,
          tenant_id: tenantId,
          expires_at: expiresAt,
          consumed_at: null,
        });
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (sql.includes("SELECT user_id FROM email_verifications")) {
        const [tokenHash] = values as [string];
        const row = tokens.get(tokenHash);
        const live =
          row !== undefined && row.consumed_at === null && row.expires_at.getTime() > Date.now();
        return Promise.resolve({
          rows: live ? [{ user_id: row!.user_id }] : [],
          rowCount: live ? 1 : 0,
        });
      }
      if (sql.includes("UPDATE email_verifications") && sql.includes("WHERE token_hash = $1")) {
        const [tokenHash] = values as [string];
        const row = tokens.get(tokenHash);
        const live =
          row !== undefined && row.consumed_at === null && row.expires_at.getTime() > Date.now();
        if (!live) return Promise.resolve({ rows: [], rowCount: 0 });
        row!.consumed_at = new Date();
        return Promise.resolve({ rows: [{ user_id: row!.user_id }], rowCount: 1 });
      }
      if (sql.includes("UPDATE email_verifications") && sql.includes("WHERE user_id = $1")) {
        const [userId] = values as [string];
        for (const row of tokens.values()) {
          if (row.user_id === userId && row.consumed_at === null) row.consumed_at = new Date();
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (sql.includes("UPDATE users")) {
        const [passwordHash, userId] = values as [string, string];
        users.set(userId, {
          password_hash: passwordHash,
          status: "active",
          email_verified_at: new Date(),
        });
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    }),
    release: vi.fn(),
  };
  return { pool: { connect: () => Promise.resolve(client) }, tokens, users, calls };
}

function fakeCredentialReader(byEmail: Record<string, AuthUserCredential>): UserCredentialReader {
  return {
    async resolveByEmail(email) {
      return byEmail[email] ?? null;
    },
    async resolveAnyByEmail(email) {
      return byEmail[email] ?? null;
    },
  };
}

async function buildApp(
  opts: {
    credentialReader?: UserCredentialReader;
    authPool?: ReturnType<typeof fakeAuthPool>["pool"];
    deliverForgotPasswordEmail?: (input: {
      tenantId: string;
      email: string;
      token: string;
      expiresAt: Date;
    }) => Promise<boolean>;
    audit?: InMemoryAuditEmitter;
  } = {},
) {
  const app = Fastify({ logger: false });
  const audit = opts.audit ?? new InMemoryAuditEmitter();
  const authPool = opts.authPool ?? fakeAuthPool().pool;
  const defaultDeliver = vi.fn<() => Promise<boolean>>(async () => true);
  const deliverForgotPasswordEmail = opts.deliverForgotPasswordEmail ?? defaultDeliver;
  await registerHumanAuthRoutes(app, {
    authPool: authPool as never,
    credentialReader: opts.credentialReader ?? fakeCredentialReader({}),
    cookieSecret: COOKIE_SECRET,
    audit,
    deliverForgotPasswordEmail,
  });
  return { app, audit, deliverForgotPasswordEmail };
}

function extractCookie(
  setCookieHeader: string | string[] | undefined,
  name: string,
): string | undefined {
  const headers = Array.isArray(setCookieHeader)
    ? setCookieHeader
    : setCookieHeader !== undefined
      ? [setCookieHeader]
      : [];
  for (const h of headers) {
    if (h.startsWith(`${name}=`)) return h.split(";")[0]!.slice(name.length + 1);
  }
  return undefined;
}

async function getCsrf(app: Awaited<ReturnType<typeof buildApp>>["app"], path: string) {
  const res = await app.inject({ method: "GET", url: path });
  const carrier = extractCookie(res.headers["set-cookie"], CSRF_COOKIE_NAME);
  if (carrier === undefined) throw new Error("no csrf carrier cookie set");
  const csrfMatch = res.body.match(/name="csrf" value="([^"]*)"/);
  if (csrfMatch === null) throw new Error("no csrf field rendered");
  return { carrier, csrfToken: csrfMatch[1]! };
}

describe("POST /login", () => {
  it("rejects a missing/invalid CSRF token with 400", async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/login",
      payload: { email: "a@example.com", password: "whatever12345", csrf: "bad" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns the same invalid-credentials response for an unknown email and a wrong password", async () => {
    const tenantId = newTenantId();
    const userId = newUserId();
    const reader = fakeCredentialReader({
      "known@example.com": {
        userId,
        tenantId,
        status: "active",
        emailVerifiedAt: new Date(),
        passwordHash: await hashPassword("correct-horse-battery-staple"),
      },
    });
    const { app } = await buildApp({ credentialReader: reader });

    const { carrier: c1, csrfToken: t1 } = await getCsrf(app, "/login");
    const unknown = await app.inject({
      method: "POST",
      url: "/login",
      headers: { cookie: `${CSRF_COOKIE_NAME}=${c1}` },
      payload: { email: "unknown@example.com", password: "whatever12345", csrf: t1 },
    });

    const { carrier: c2, csrfToken: t2 } = await getCsrf(app, "/login");
    const wrongPassword = await app.inject({
      method: "POST",
      url: "/login",
      headers: { cookie: `${CSRF_COOKIE_NAME}=${c2}` },
      payload: { email: "known@example.com", password: "totally-wrong-password", csrf: t2 },
    });

    expect(unknown.statusCode).toBe(401);
    expect(wrongPassword.statusCode).toBe(401);
    expect(unknown.body).toContain("Invalid email or password");
    expect(wrongPassword.body).toContain("Invalid email or password");
  });

  it("refuses an unverified email even with the correct password", async () => {
    const reader = fakeCredentialReader({
      "pending@example.com": {
        userId: newUserId(),
        tenantId: newTenantId(),
        status: "pending",
        emailVerifiedAt: null,
        passwordHash: await hashPassword("correct-horse-battery-staple"),
      },
    });
    const { app } = await buildApp({ credentialReader: reader });
    const { carrier, csrfToken } = await getCsrf(app, "/login");
    const res = await app.inject({
      method: "POST",
      url: "/login",
      headers: { cookie: `${CSRF_COOKIE_NAME}=${carrier}` },
      payload: {
        email: "pending@example.com",
        password: "correct-horse-battery-staple",
        csrf: csrfToken,
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("Verify your email");
  });

  it("mints a session cookie and audits auth.login on success", async () => {
    const tenantId = newTenantId();
    const userId = newUserId();
    const reader = fakeCredentialReader({
      "founder@example.com": {
        userId,
        tenantId,
        status: "active",
        emailVerifiedAt: new Date(),
        passwordHash: await hashPassword("correct-horse-battery-staple"),
      },
    });
    const audit = new InMemoryAuditEmitter();
    const { app } = await buildApp({ credentialReader: reader, audit });
    const { carrier, csrfToken } = await getCsrf(app, "/login");
    const res = await app.inject({
      method: "POST",
      url: "/login",
      headers: { cookie: `${CSRF_COOKIE_NAME}=${carrier}` },
      payload: {
        email: "founder@example.com",
        password: "correct-horse-battery-staple",
        csrf: csrfToken,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(extractCookie(res.headers["set-cookie"], SESSION_COOKIE_NAME)).toBeDefined();
    expect(audit.events.some((e) => e.action === "auth.login" && e.actor === userId)).toBe(true);
  });
});

describe("GET/POST /set-password", () => {
  it("renders the invalid-link page for an unknown token", async () => {
    const { app } = await buildApp();
    const tenantId = newTenantId();
    const res = await app.inject({ method: "GET", url: `/set-password?tid=${tenantId}&t=nope` });
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain("invalid, expired, or has already been used");
  });

  it("rejects a password under 12 characters", async () => {
    const { sha256Hex } = await import("../src/token.js");
    const { pool, tokens } = fakeAuthPool();
    const tenantId = newTenantId();
    const userId = newUserId();
    const rawToken = "a-raw-token-value-too-short-case";
    tokens.set(sha256Hex(rawToken), {
      token_hash: sha256Hex(rawToken),
      user_id: userId,
      tenant_id: tenantId,
      expires_at: new Date(Date.now() + 60_000),
      consumed_at: null,
    });
    const { app } = await buildApp({ authPool: pool });
    const { carrier, csrfToken } = await getCsrf(
      app,
      `/set-password?tid=${tenantId}&t=${rawToken}`,
    );
    const res = await app.inject({
      method: "POST",
      url: "/set-password",
      headers: { cookie: `${CSRF_COOKIE_NAME}=${carrier}` },
      payload: { tid: tenantId, t: rawToken, password: "short", csrf: csrfToken },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("at least 12 characters");
  });

  it("consumes the token, redirects to /login, and never sets a session cookie", async () => {
    // sha256Hex is not mocked -- seed the fake store under the raw token's own
    // hash so the route's real sha256Hex(rawToken) lookup hits it.
    const { sha256Hex } = await import("../src/token.js");
    const { pool, tokens } = fakeAuthPool();
    const tenantId = newTenantId();
    const userId = newUserId();
    const rawToken = "a-raw-token-value";
    tokens.set(sha256Hex(rawToken), {
      token_hash: sha256Hex(rawToken),
      user_id: userId,
      tenant_id: tenantId,
      expires_at: new Date(Date.now() + 60_000),
      consumed_at: null,
    });
    const audit = new InMemoryAuditEmitter();
    const { app } = await buildApp({ authPool: pool, audit });
    const { carrier, csrfToken } = await getCsrf(
      app,
      `/set-password?tid=${tenantId}&t=${rawToken}`,
    );

    const res = await app.inject({
      method: "POST",
      url: "/set-password",
      headers: { cookie: `${CSRF_COOKIE_NAME}=${carrier}` },
      payload: { tid: tenantId, t: rawToken, password: "a-fine-new-password", csrf: csrfToken },
    });

    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login?notice=password_set");
    expect(extractCookie(res.headers["set-cookie"], SESSION_COOKIE_NAME)).toBeUndefined();
    expect(audit.events.some((e) => e.action === "auth.password_set")).toBe(true);

    // Replay: the same token is now consumed. GET /set-password itself also
    // 404s for it now (checked separately below); mint the CSRF carrier from
    // /login instead, since a carrier isn't tied to which page rendered it.
    const replayGet = await app.inject({
      method: "GET",
      url: `/set-password?tid=${tenantId}&t=${rawToken}`,
    });
    expect(replayGet.statusCode).toBe(404);
    const { carrier: c2, csrfToken: t2 } = await getCsrf(app, "/login");
    const replay = await app.inject({
      method: "POST",
      url: "/set-password",
      headers: { cookie: `${CSRF_COOKIE_NAME}=${c2}` },
      payload: { tid: tenantId, t: rawToken, password: "another-fine-password", csrf: t2 },
    });
    expect(replay.statusCode).toBe(404);
  });
});

describe("POST /forgot-password", () => {
  it("returns the same 202 for an unknown email and never calls the email sender", async () => {
    const deliver = vi.fn(async () => true);
    const { app } = await buildApp({ deliverForgotPasswordEmail: deliver });
    const { carrier, csrfToken } = await getCsrf(app, "/forgot-password");
    const res = await app.inject({
      method: "POST",
      url: "/forgot-password",
      headers: { cookie: `${CSRF_COOKIE_NAME}=${carrier}` },
      payload: { email: "nobody@example.com", csrf: csrfToken },
    });
    expect(res.statusCode).toBe(202);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("returns the identical 202 body shape for a known email and does call the sender", async () => {
    const tenantId = newTenantId();
    const userId = newUserId();
    const reader = fakeCredentialReader({
      "known@example.com": {
        userId,
        tenantId,
        status: "active",
        emailVerifiedAt: new Date(),
        passwordHash: null,
      },
    });
    const deliver = vi.fn(async () => true);
    const { pool } = fakeAuthPool();
    const { app } = await buildApp({
      credentialReader: reader,
      deliverForgotPasswordEmail: deliver,
      authPool: pool,
    });

    const { carrier: c1, csrfToken: t1 } = await getCsrf(app, "/forgot-password");
    const unknownRes = await app.inject({
      method: "POST",
      url: "/forgot-password",
      headers: { cookie: `${CSRF_COOKIE_NAME}=${c1}` },
      payload: { email: "nobody@example.com", csrf: t1 },
    });

    const { carrier: c2, csrfToken: t2 } = await getCsrf(app, "/forgot-password");
    const knownRes = await app.inject({
      method: "POST",
      url: "/forgot-password",
      headers: { cookie: `${CSRF_COOKIE_NAME}=${c2}` },
      payload: { email: "known@example.com", csrf: t2 },
    });

    expect(unknownRes.statusCode).toBe(202);
    expect(knownRes.statusCode).toBe(202);
    // Identical response shape either way (the csrf token itself differs per
    // render, so strip it before comparing) -- the anti-enumeration invariant.
    const strip = (body: string) => body.replace(/name="csrf" value="[^"]*"/, "");
    expect(strip(unknownRes.body)).toBe(strip(knownRes.body));
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ email: "known@example.com" }));
  });
});
