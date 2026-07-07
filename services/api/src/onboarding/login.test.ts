import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { beforeAll, describe, expect, it } from "vitest";
import {
  authPlugin,
  errorHandlerPlugin,
  requestIdPlugin,
  InMemoryAuditEmitter,
  JwtSigner,
  JwtVerifier,
  hashPassword,
  requireScope,
  type Scope,
} from "@brain/shared";
import {
  registerPasswordLoginRoute,
  OWNER_SCOPES,
  type ResolveUserByEmail,
  type UserCredential,
} from "./login.js";
import { registerOnboardingRoutes } from "./routes.js";

const HS256_KEY = {
  kty: "oct",
  k: "Y3JlYXRlZF9pbl90ZXN0X2Vudmlyb25tZW50X29ubHlf", // gitleaks:allow
  alg: "HS256",
};
const HS256_SECRET = "created_in_test_environment_only_";
const ISSUER = "https://auth.brain.fi.test";
const AUDIENCE = "https://api.brain.fi.test";

const PASSWORD = "correct horse battery staple";
let PASSWORD_HASH = "";

beforeAll(async () => {
  PASSWORD_HASH = await hashPassword(PASSWORD);
});

async function buildApp(
  resolveUserByEmail: ResolveUserByEmail,
): Promise<{ app: FastifyInstance; audit: InMemoryAuditEmitter }> {
  const app = Fastify({ logger: false });
  await app.register(requestIdPlugin);
  await app.register(errorHandlerPlugin);
  const audit = new InMemoryAuditEmitter();
  const signer = new JwtSigner({
    issuer: ISSUER,
    audience: AUDIENCE,
    key: HS256_KEY,
    algorithm: "HS256",
  });
  await registerPasswordLoginRoute(app, {
    resolveUserByEmail,
    signer,
    audit,
    tokenTtlSeconds: 900,
  });
  await app.ready();
  return { app, audit };
}

const ACTIVE_USER: UserCredential = {
  userId: "user_01J0000000000000000000000A",
  tenantId: "tnt_01J0000000000000000000000Z",
  status: "active",
  get passwordHash() {
    return PASSWORD_HASH;
  },
};

describe("POST /auth/login — RFC 0002 Phase B", () => {
  it("issues an owner JWT on valid credentials (scopes: manage/read/approve, never propose/execute)", async () => {
    const { app, audit } = await buildApp(async () => ACTIVE_USER);
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "Founder@Example.com", password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBe(900);
    expect(body.access_token.split(".")).toHaveLength(3); // header.payload.sig
    expect(body.principal.type).toBe("user");
    expect(body.principal.scopes).toEqual(OWNER_SCOPES);
    expect(body.principal.scopes).toContain("raw:read");
    expect(body.principal.scopes).toContain("raw:write");
    // The capability boundary: no money-moving scopes on a human login.
    for (const forbidden of [
      "payment_intent:propose",
      "payment_intent:execute",
      "execution:propose",
    ]) {
      expect(body.principal.scopes).not.toContain(forbidden);
    }
    expect(audit.events.map((e) => e.action)).toContain("auth.login");
    await app.close();
  });

  it("lets a verified self-serve owner token pass the raw ingest scope gate", async () => {
    const state = makeSelfServeState();
    const app = Fastify({ logger: false });
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
    });
    const audit = new InMemoryAuditEmitter();
    await registerOnboardingRoutes(app, {
      pool: state.pool,
      audit,
      exposeVerificationToken: true,
    });
    await registerPasswordLoginRoute(app, {
      resolveUserByEmail: (email) => Promise.resolve(state.resolveUserByEmail(email)),
      signer: new JwtSigner({
        issuer: ISSUER,
        audience: AUDIENCE,
        key: HS256_KEY,
        algorithm: "HS256",
      }),
      audit,
      tokenTtlSeconds: 900,
    });
    app.post("/raw/ingest", async (request) => {
      requireScope(request.principal?.scopes ?? [], "raw:write" as Scope);
      return { raw_id: "raw_test", accepted: true };
    });
    await app.ready();

    const signup = await app.inject({
      method: "POST",
      url: "/signup",
      payload: { email: "Founder@Example.com", password: PASSWORD },
    });
    expect(signup.statusCode).toBe(201);
    const signupBody = signup.json();

    const verify = await app.inject({
      method: "POST",
      url: "/auth/verify-email",
      payload: {
        tenant_id: signupBody.tenant_id,
        token: signupBody.verification_token,
      },
    });
    expect(verify.statusCode).toBe(200);

    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "founder@example.com", password: PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    const loginBody = login.json();
    expect(loginBody.principal.scopes).toContain("raw:write");

    const ingest = await app.inject({
      method: "POST",
      url: "/raw/ingest",
      headers: { authorization: `Bearer ${loginBody.access_token}` },
      payload: { sourceType: "manual_upload", sourceRef: "invoice.pdf", body: "hello" },
    });
    expect(ingest.statusCode).toBe(200);
    expect(ingest.json()).toMatchObject({ accepted: true });
    await app.close();
  });

  it("rejects a wrong password with 401 auth_invalid_credentials", async () => {
    const { app } = await buildApp(async () => ACTIVE_USER);
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "founder@example.com", password: "wrong-password-here" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("auth_invalid_credentials");
    await app.close();
  });

  it("rejects an unknown email with the SAME 401 (no user enumeration)", async () => {
    const { app } = await buildApp(async () => null);
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "nobody@example.com", password: PASSWORD },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("auth_invalid_credentials");
    await app.close();
  });

  it("rejects an unverified (pending) account with 403 auth_email_unverified", async () => {
    const { app } = await buildApp(async () => ({ ...ACTIVE_USER, status: "pending" }));
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "founder@example.com", password: PASSWORD },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("auth_email_unverified");
    await app.close();
  });

  it("rejects a malformed body with 400", async () => {
    const { app } = await buildApp(async () => ACTIVE_USER);
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "founder@example.com" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("request_body_invalid");
    await app.close();
  });
});

function makeSelfServeState(): {
  pool: Pool;
  resolveUserByEmail: (email: string) => UserCredential | null;
} {
  const users = new Map<
    string,
    {
      id: string;
      tenantId: string;
      email: string;
      status: string;
      passwordHash: string;
    }
  >();
  const verification = new Map<string, { userId: string; tenantId: string }>();
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      if (
        sql === "BEGIN" ||
        sql === "COMMIT" ||
        sql === "ROLLBACK" ||
        sql.startsWith("SELECT set_config")
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (/INSERT INTO users/.test(sql)) {
        const [id, tenantId, email, passwordHash] = values as [string, string, string, string];
        users.set(email.toLowerCase(), {
          id,
          tenantId,
          email: email.toLowerCase(),
          status: "pending",
          passwordHash,
        });
        return { rows: [], rowCount: 1 };
      }
      if (/INSERT INTO email_verifications/.test(sql)) {
        const [tokenHash, userId, tenantId] = values as [string, string, string];
        verification.set(tokenHash, { userId, tenantId });
        return { rows: [], rowCount: 1 };
      }
      if (/SELECT user_id FROM email_verifications/.test(sql)) {
        const [tokenHash] = values as [string];
        const row = verification.get(tokenHash);
        return {
          rows: row === undefined ? [] : [{ user_id: row.userId }],
          rowCount: row === undefined ? 0 : 1,
        };
      }
      if (/UPDATE users SET status = 'active'/.test(sql)) {
        const [userId] = values as [string];
        for (const user of users.values()) {
          if (user.id === userId) user.status = "active";
        }
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
    release: () => undefined,
  };
  return {
    pool: { connect: async () => client } as unknown as Pool,
    resolveUserByEmail: (email: string) => {
      const user = users.get(email.toLowerCase());
      if (user === undefined) return null;
      return {
        userId: user.id,
        tenantId: user.tenantId,
        status: user.status,
        passwordHash: user.passwordHash,
      };
    },
  };
}
