import Fastify, { type FastifyInstance } from "fastify";
import { beforeAll, describe, expect, it } from "vitest";
import {
  errorHandlerPlugin,
  requestIdPlugin,
  InMemoryAuditEmitter,
  JwtSigner,
  hashPassword,
} from "@brain/shared";
import {
  registerPasswordLoginRoute,
  OWNER_SCOPES,
  type ResolveUserByEmail,
  type UserCredential,
} from "./login.js";

const HS256_KEY = {
  kty: "oct",
  k: "Y3JlYXRlZF9pbl90ZXN0X2Vudmlyb25tZW50X29ubHlf", // gitleaks:allow
  alg: "HS256",
};

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
    issuer: "https://auth.brain.fi.test",
    audience: "https://api.brain.fi.test",
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
