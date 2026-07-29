/**
 * Fast route-level tests for POST /register, no live database. Opus review
 * (Phase 3 follow-up), finding 4: the unit tests only ever exercised
 * client-registration.ts directly, so the route itself -- status codes,
 * response shape, headers -- was untested; changing `reply.code(400)` to
 * `200` or dropping the `no-store` header would have passed everything.
 *
 * Every test below hits the real route through buildAuthApp + app.inject
 * (server-trust-proxy.test.ts's pattern), with a stub authPool: the 400 and
 * content-type-rejection paths never reach the database at all, and the two
 * DB-touching tests (201, 500) use a minimal fake `Pool` rather than a live
 * one.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { generateSignKeyJwk, InMemoryAuditEmitter } from "@brain/shared";
import { buildAuthApp } from "../src/server.js";

const REDIRECT_URI = "https://client.example.test/cb";

let app: FastifyInstance | undefined;

afterEach(async () => {
  if (app !== undefined) await app.close();
  app = undefined;
});

async function buildApp(authPool: Pool): Promise<FastifyInstance> {
  const jwk = await generateSignKeyJwk();
  return buildAuthApp({
    issuer: "https://auth.brain.fi",
    signKey: JSON.stringify(jwk),
    serviceName: "brain-auth",
    serviceVersion: "0.0.0-dev",
    commit: "deadbeef",
    logger: false,
    // /register is only wired when oauthCore is present (server.ts). The
    // fields below other than authPool are never exercised by these tests.
    oauthCore: {
      authPool,
      resolverPool: {} as never,
      cookieSecret: "test-cookie-secret-do-not-use-in-prod",
      audit: new InMemoryAuditEmitter(),
      signer: {} as never,
      onchain: {} as never,
      authAudience: "brain-api",
      mcpPublicResourceUrl: "https://mcp.brain.fi",
    },
  });
}

/** Never queried: every test using this stub fails validation or the content-type check before touching the database. */
const UNUSED_POOL = {
  query: async () => {
    throw new Error("this test must not reach the database");
  },
} as unknown as Pool;

function jsonPost(body: unknown): {
  method: "POST";
  url: string;
  headers: Record<string, string>;
  payload: string;
} {
  return {
    method: "POST",
    url: "/register",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify(body),
  };
}

describe("POST /register: validation failures never reach the database", () => {
  it("400s with an RFC 7591 section 3.2.2-shaped body and sets cache-control: no-store", async () => {
    app = await buildApp(UNUSED_POOL);
    const res = await app.inject(jsonPost({}));
    expect(res.statusCode).toBe(400);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json() as { error: string; error_description: string };
    expect(body.error).toBe("invalid_redirect_uri");
    expect(typeof body.error_description).toBe("string");
    expect(body.error_description.length).toBeGreaterThan(0);
  });

  it("rejects a non-https, non-loopback redirect_uri with invalid_redirect_uri", async () => {
    app = await buildApp(UNUSED_POOL);
    const res = await app.inject(jsonPost({ redirect_uris: ["http://example.test/cb"] }));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_redirect_uri" });
  });

  it("rejects a redirect_uri containing a fragment with invalid_redirect_uri", async () => {
    app = await buildApp(UNUSED_POOL);
    const res = await app.inject(jsonPost({ redirect_uris: ["https://example.test/cb#frag"] }));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_redirect_uri" });
  });

  it("rejects an invalid_client_metadata case too (grant_types outside the supported set)", async () => {
    app = await buildApp(UNUSED_POOL);
    const res = await app.inject(
      jsonPost({ redirect_uris: [REDIRECT_URI], grant_types: ["implicit"] }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_client_metadata" });
  });
});

describe("POST /register: content type (RFC 7591 section 3.1 requires JSON)", () => {
  it("rejects an application/x-www-form-urlencoded body even though server.ts parses it globally", async () => {
    app = await buildApp(UNUSED_POOL);
    const res = await app.inject({
      method: "POST",
      url: "/register",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ redirect_uris: REDIRECT_URI }).toString(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_client_metadata" });
  });

  it("a request with no content-type at all never reaches the route (Fastify's own 415, verified empirically)", async () => {
    // Confirmed by running this test: a non-empty body with no content-type
    // header is rejected by Fastify's own content-type-parser.js BEFORE any
    // route handler runs (no parser registered for the empty-string content
    // type), so this route's own check never executes and the body is NOT
    // this route's {error, error_description} shape. That upstream 415 is
    // already adequate for this case; the explicit isJsonContentType check
    // in register.ts exists for the one content type Fastify WOULD otherwise
    // successfully parse -- application/x-www-form-urlencoded, registered
    // server-wide by server.ts for the real HTML forms.
    app = await buildApp(UNUSED_POOL);
    const res = await app.inject({
      method: "POST",
      url: "/register",
      payload: JSON.stringify({ redirect_uris: [REDIRECT_URI] }),
    });
    expect(res.statusCode).toBe(415);
  });
});

describe("POST /register: success and server-error paths", () => {
  it("201s with the RFC 7591 section 3.2.1 shape and cache-control: no-store", async () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const pool = { query: async () => ({ rows: [{ created_at: createdAt }] }) } as unknown as Pool;
    app = await buildApp(pool);

    const res = await app.inject(jsonPost({ redirect_uris: [REDIRECT_URI] }));
    expect(res.statusCode).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json() as Record<string, unknown>;
    expect(body["client_id"]).toMatch(/^oacl_/);
    expect(body["client_id_issued_at"]).toBe(Math.floor(createdAt.getTime() / 1000));
    expect(body["token_endpoint_auth_method"]).toBe("none");
    expect(body).not.toHaveProperty("client_secret");
    expect(body).not.toHaveProperty("client_secret_expires_at");
    expect(body).not.toHaveProperty("registration_access_token");
  });

  it("never leaks a raw database error, returning a generic server_error instead", async () => {
    const pool = {
      query: async () => {
        throw new Error("permission denied for table oauth_clients");
      },
    } as unknown as Pool;
    app = await buildApp(pool);

    const res = await app.inject(jsonPost({ redirect_uris: [REDIRECT_URI] }));
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("permission denied");
    expect(res.json()).toEqual({
      error: "server_error",
      error_description: "Client registration failed.",
    });
  });
});
