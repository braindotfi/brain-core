import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { generateSignKeyJwk } from "@brain/shared";
import { buildAuthApp } from "../src/server.js";
import { WELL_KNOWN_AS_PATH, WELL_KNOWN_JWKS_PATH } from "../src/metadata.js";

const ISSUER = "https://auth.brain.fi";
// The in-network fetch URL AUTH_JWKS_URL actually holds in prod
// (docker-compose.prod.yml). The served metadata must never equal this.
const AUTH_JWKS_URL = "http://jwks:8085/.well-known/jwks.json";

let app: FastifyInstance;
let privateJwkKid: string;

beforeAll(async () => {
  const privateJwk = await generateSignKeyJwk();
  privateJwkKid = privateJwk.kid!;
  app = await buildAuthApp({
    issuer: ISSUER,
    signKey: JSON.stringify(privateJwk),
    serviceName: "brain-auth",
    serviceVersion: "0.0.0-dev",
    commit: "deadbeef",
    logger: false,
  });
});

afterAll(async () => {
  await app.close();
});

describe("GET /healthz", () => {
  it("reports the deployed commit, matching the /health pattern the deploy smoke asserts on", async () => {
    const r = await app.inject({ method: "GET", url: "/healthz" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, commit: "deadbeef" });
  });
});

describe("GET /.well-known/oauth-authorization-server", () => {
  it("serves metadata whose jwks_uri is derived from AUTH_ISSUER and is not AUTH_JWKS_URL", async () => {
    const r = await app.inject({ method: "GET", url: WELL_KNOWN_AS_PATH });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("application/json");
    const body = r.json();
    expect(body.issuer).toBe(ISSUER);
    expect(body.jwks_uri).toBe(`${ISSUER}${WELL_KNOWN_JWKS_PATH}`);
    expect(body.jwks_uri).not.toBe(AUTH_JWKS_URL);
  });
});

describe("GET /.well-known/jwks.json", () => {
  it("serves the identical kid the private AUTH_SIGN_KEY carries, with no private material", async () => {
    const r = await app.inject({ method: "GET", url: WELL_KNOWN_JWKS_PATH });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { keys: Array<Record<string, unknown>> };
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]?.["kid"]).toBe(privateJwkKid);
    for (const member of ["d", "p", "q", "dp", "dq", "qi"]) {
      expect(body.keys[0]).not.toHaveProperty(member);
    }
  });
});

describe("interim stubs (Phase 1 mode: no oauthCore supplied)", () => {
  it("GET /authorize returns 503 with an RFC 6749 error body", async () => {
    const r = await app.inject({ method: "GET", url: "/authorize" });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ error: "temporarily_unavailable" });
  });

  it("POST /token returns 503 with an RFC 6749 error body and no-store (section 5.1)", async () => {
    const r = await app.inject({ method: "POST", url: "/token" });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ error: "temporarily_unavailable" });
    expect(r.headers["cache-control"]).toBe("no-store");
  });
});

describe("Phase 2a increment 3: oauthCore replaces the stubs when supplied", () => {
  it("GET /authorize is no longer the 503 stub -- it renders the open-redirect-safe error page for an unknown client_id", async () => {
    const jwk = await generateSignKeyJwk();
    const withOauthCore = await buildAuthApp({
      issuer: ISSUER,
      signKey: JSON.stringify(jwk),
      serviceName: "brain-auth",
      serviceVersion: "0.0.0-dev",
      commit: "deadbeef",
      logger: false,
      oauthCore: {
        authPool: { query: async () => ({ rows: [], rowCount: 0 }) } as never,
        resolverPool: { query: async () => ({ rows: [], rowCount: 0 }) } as never,
        cookieSecret: "test-cookie-secret-do-not-use-in-prod",
        audit: {
          emit: async () => ({ id: "evt_test", eventHash: "h", prevEventHash: null }),
        } as never,
        signer: { sign: async () => "unused" } as never,
        onchain: { getOnchainScopeHash: async () => null },
        authAudience: "brain-api",
        mcpPublicResourceUrl: "https://mcp.brain.fi",
      },
    });
    try {
      const r = await withOauthCore.inject({ method: "GET", url: "/authorize" });
      expect(r.statusCode).not.toBe(503);
      expect(r.statusCode).toBe(400);
      expect(r.body).toContain("Unknown or disabled OAuth client");
    } finally {
      await withOauthCore.close();
    }
  });
});

describe("GET / (bare root)", () => {
  it("404s in a discovery-only build, which has no /login to send anyone to", async () => {
    const r = await app.inject({ method: "GET", url: "/" });
    expect(r.statusCode).toBe(404);
  });

  it("redirects to /login once human auth is wired, so the public origin is not a bare JSON 404", async () => {
    const jwk = await generateSignKeyJwk();
    const withHumanAuth = await buildAuthApp({
      issuer: ISSUER,
      signKey: JSON.stringify(jwk),
      serviceName: "brain-auth",
      serviceVersion: "0.0.0-dev",
      commit: "deadbeef",
      logger: false,
      humanAuth: {
        authPool: { query: async () => ({ rows: [], rowCount: 0 }) } as never,
        credentialReader: { findByEmail: async () => null } as never,
        cookieSecret: "test-cookie-secret-do-not-use-in-prod",
        audit: {
          emit: async () => ({ id: "evt_test", eventHash: "h", prevEventHash: null }),
        } as never,
        deliverForgotPasswordEmail: async () => true,
      },
    });
    try {
      const r = await withHumanAuth.inject({ method: "GET", url: "/" });
      expect(r.statusCode).toBe(302);
      expect(r.headers.location).toBe("/login");
    } finally {
      await withHumanAuth.close();
    }
  });
});
