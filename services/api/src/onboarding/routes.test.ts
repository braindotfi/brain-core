import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { errorHandlerPlugin, requestIdPlugin, InMemoryAuditEmitter } from "@brain/shared";
import { registerOnboardingRoutes } from "./routes.js";

/**
 * Fake pool that transparently handles BEGIN/COMMIT/ROLLBACK/set_config and
 * delegates domain queries to `handler`. `failOn` simulates a DB error.
 */
function makeFakePool(opts: {
  handler?: (sql: string, values: unknown[]) => { rows: unknown[]; rowCount: number };
  failOn?: RegExp;
  failCode?: string;
}): Pool {
  const client = {
    query: vi.fn((sql: string, values?: unknown[]) => {
      if (
        sql === "BEGIN" ||
        sql === "COMMIT" ||
        sql === "ROLLBACK" ||
        sql.startsWith("SELECT set_config")
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (opts.failOn !== undefined && opts.failOn.test(sql)) {
        const err = new Error("db error") as Error & { code?: string };
        err.code = opts.failCode ?? "23505";
        return Promise.reject(err);
      }
      return Promise.resolve(opts.handler?.(sql, values ?? []) ?? { rows: [], rowCount: 0 });
    }),
    release: vi.fn(),
  };
  return { connect: vi.fn(() => Promise.resolve(client)) } as unknown as Pool;
}

async function buildApp(
  pool: Pool,
  opts: { exposeVerificationToken?: boolean } = {},
): Promise<{ app: FastifyInstance; audit: InMemoryAuditEmitter }> {
  const app = Fastify({ logger: false });
  await app.register(requestIdPlugin);
  await app.register(errorHandlerPlugin);
  const audit = new InMemoryAuditEmitter();
  await registerOnboardingRoutes(app, {
    pool,
    audit,
    exposeVerificationToken: opts.exposeVerificationToken ?? true,
  });
  await app.ready();
  return { app, audit };
}

const GOOD_SIGNUP = { email: "Founder@Example.com", password: "correct horse battery staple" };

describe("POST /signup — RFC 0002 Phase B", () => {
  it("provisions a sandbox tenant + owner and returns the verification token (non-prod)", async () => {
    const { app, audit } = await buildApp(makeFakePool({}));
    const res = await app.inject({ method: "POST", url: "/signup", payload: GOOD_SIGNUP });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.tenant_id).toMatch(/^tnt_/);
    expect(body.user_id).toMatch(/^user_/);
    expect(body.status).toBe("pending");
    expect(typeof body.verification_token).toBe("string");
    expect(body.verification_token.length).toBeGreaterThan(20);

    // Audited as identity-layer events.
    const actions = audit.events.map((e) => e.action);
    expect(actions).toContain("tenant.created");
    expect(actions).toContain("user.created");
    expect(audit.events.every((e) => e.layer === "identity")).toBe(true);
    await app.close();
  });

  it("hides the raw token when exposeVerificationToken is false (prod posture)", async () => {
    const { app } = await buildApp(makeFakePool({}), { exposeVerificationToken: false });
    const res = await app.inject({ method: "POST", url: "/signup", payload: GOOD_SIGNUP });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.verification_token).toBeUndefined();
    expect(body.verification_sent).toBe(true);
    await app.close();
  });

  it("rejects a weak/short password with 400 request_body_invalid", async () => {
    const { app } = await buildApp(makeFakePool({}));
    const res = await app.inject({
      method: "POST",
      url: "/signup",
      payload: { email: "a@b.com", password: "short" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("request_body_invalid");
    await app.close();
  });

  it("maps a duplicate email to 409 signup_email_taken", async () => {
    const { app } = await buildApp(
      makeFakePool({ failOn: /INSERT INTO users/, failCode: "23505" }),
    );
    const res = await app.inject({ method: "POST", url: "/signup", payload: GOOD_SIGNUP });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("signup_email_taken");
    await app.close();
  });
});

describe("POST /auth/verify-email — RFC 0002 Phase B", () => {
  const TENANT = "tnt_01J0000000000000000000000Z";

  it("activates the owner when the token matches an unconsumed row", async () => {
    const pool = makeFakePool({
      handler: (sql) =>
        /SELECT user_id FROM email_verifications/.test(sql)
          ? { rows: [{ user_id: "user_01J0000000000000000000000A" }], rowCount: 1 }
          : { rows: [], rowCount: 0 },
    });
    const { app, audit } = await buildApp(pool);
    const res = await app.inject({
      method: "POST",
      url: "/auth/verify-email",
      payload: { tenant_id: TENANT, token: "raw-token-abc" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ verified: true, status: "active" });
    expect(audit.events.map((e) => e.action)).toContain("user.email_verified");
    await app.close();
  });

  it("rejects an unknown/expired token with 400 signup_token_invalid", async () => {
    const pool = makeFakePool({ handler: () => ({ rows: [], rowCount: 0 }) });
    const { app } = await buildApp(pool);
    const res = await app.inject({
      method: "POST",
      url: "/auth/verify-email",
      payload: { tenant_id: TENANT, token: "nope" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("signup_token_invalid");
    await app.close();
  });

  it("rejects a malformed tenant_id with 400", async () => {
    const { app } = await buildApp(makeFakePool({}));
    const res = await app.inject({
      method: "POST",
      url: "/auth/verify-email",
      payload: { tenant_id: "not-a-tenant", token: "x" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("request_body_invalid");
    await app.close();
  });
});
