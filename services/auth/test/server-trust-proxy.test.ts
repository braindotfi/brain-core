/**
 * Finding 4: `buildAuthApp` built its Fastify instance with no `trustProxy`,
 * unlike `services/api/src/main.ts`'s root app (`trustProxy: true`). Caddy
 * fronts `auth.brain.fi` exactly like it fronts `api.brain.fi`, so every
 * request's immediate peer is the Caddy container -- without `trustProxy`,
 * `request.ip` (and therefore @fastify/rate-limit's default IP key) is
 * constant for every real client, and every distinct visitor collapses into
 * one shared rate-limit bucket.
 *
 * This proves the fix two ways against the REAL app, not a config read:
 * `request.ip` actually reflects `X-Forwarded-For` per request, and two
 * different forwarded clients get INDEPENDENT rate-limit buckets on the
 * same limited route (/login, max 10/min).
 */

import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { generateSignKeyJwk, InMemoryAuditEmitter } from "@brain/shared";
import { buildAuthApp } from "../src/server.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  if (app !== undefined) await app.close();
  app = undefined;
});

async function buildApp(): Promise<FastifyInstance> {
  const jwk = await generateSignKeyJwk();
  return buildAuthApp({
    issuer: "https://auth.brain.fi",
    signKey: JSON.stringify(jwk),
    serviceName: "brain-auth",
    serviceVersion: "0.0.0-dev",
    commit: "deadbeef",
    logger: false,
    // /login only exists (and only carries its rate limit) when humanAuth is
    // wired -- the deps below are never exercised by this test (GET /login
    // just renders the form) so stubs are fine.
    humanAuth: {
      authPool: {} as never,
      credentialReader: {
        resolveByEmail: async () => null,
        resolveAnyByEmail: async () => null,
      },
      cookieSecret: "test-cookie-secret-do-not-use-in-prod",
      audit: new InMemoryAuditEmitter(),
      deliverForgotPasswordEmail: async () => true,
    },
  });
}

describe("buildAuthApp trusts the Caddy hop for the real client IP", () => {
  it("request.ip reflects X-Forwarded-For, not the constant proxy address", async () => {
    app = await buildApp();
    app.get("/__whoami", async (req) => ({ ip: req.ip }));
    await app.ready();

    const a = await app.inject({
      method: "GET",
      url: "/__whoami",
      headers: { "x-forwarded-for": "203.0.113.5" },
    });
    const b = await app.inject({
      method: "GET",
      url: "/__whoami",
      headers: { "x-forwarded-for": "198.51.100.9" },
    });

    expect(a.json()).toEqual({ ip: "203.0.113.5" });
    expect(b.json()).toEqual({ ip: "198.51.100.9" });
  });

  it("/login rate-limits distinct forwarded clients independently, not into one shared bucket", async () => {
    app = await buildApp();
    await app.ready();

    // /login's config is { max: 10, timeWindow: "1 minute" }. Exhaust client
    // A's bucket entirely.
    let lastA: Awaited<ReturnType<typeof app.inject>> | undefined;
    for (let i = 0; i < 10; i++) {
      lastA = await app.inject({
        method: "GET",
        url: "/login",
        headers: { "x-forwarded-for": "203.0.113.5" },
      });
    }
    expect(lastA?.statusCode).toBe(200);
    const eleventhA = await app.inject({
      method: "GET",
      url: "/login",
      headers: { "x-forwarded-for": "203.0.113.5" },
    });
    expect(eleventhA.statusCode).toBe(429); // A's own bucket is exhausted.

    // Client B, a DIFFERENT forwarded IP, must be unaffected: if trustProxy
    // were missing, both A and B would collapse onto the same constant
    // peer-address key and B would already be 429 here too.
    const firstB = await app.inject({
      method: "GET",
      url: "/login",
      headers: { "x-forwarded-for": "198.51.100.9" },
    });
    expect(firstB.statusCode).toBe(200);
  });
});
