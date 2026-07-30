/**
 * Finding 4 (Phase 2a): `buildAuthApp` built its Fastify instance with no
 * `trustProxy`. Caddy fronts `auth.brain.fi` as the sole ingress, so every
 * request's immediate peer is the Caddy container -- without `trustProxy`,
 * `request.ip` (and therefore @fastify/rate-limit's default IP key) is
 * constant for every real client, and every distinct visitor collapses into
 * one shared rate-limit bucket.
 *
 * Opus review, Phase 3 follow-up: the original fix (`trustProxy: true`) went
 * too far. `true` trusts every hop in X-Forwarded-For unconditionally, so
 * `req.ip` resolves to the header's LEFTMOST entry (server.ts's header
 * comment traces this through fastify/lib/request.js and
 * @fastify/proxy-addr) -- and the leftmost entry is exactly what a caller
 * supplies, spoofable per request with no proxy involved at all. `server.ts`
 * now uses `trustProxy: 1`: trust only the direct TCP peer (Caddy), so
 * `req.ip` resolves to the RIGHTMOST entry -- the one Caddy itself appended
 * (or set) from the connection it actually terminated.
 *
 * This proves both properties against the REAL app, not a config read:
 * `request.ip` still reflects a single-valued `X-Forwarded-For` (unchanged
 * behavior, single entry has no leftmost/rightmost distinction), two
 * different forwarded clients still get INDEPENDENT rate-limit buckets, and
 * -- the new case -- an attacker who prepends a forged hop ahead of the real
 * one cannot manufacture a fresh bucket: `req.ip` is the RIGHTMOST entry, not
 * the leftmost/spoofed one.
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

  it("request.ip is the RIGHTMOST X-Forwarded-For entry, not the leftmost/spoofable one", async () => {
    app = await buildApp();
    app.get("/__whoami", async (req) => ({ ip: req.ip }));
    await app.ready();

    // Simulates Caddy appending the real client IP after a forged leftmost
    // hop the attacker fully controls. trustProxy: 1 must resolve to the
    // rightmost entry (203.0.113.77, what Caddy actually observed), never the
    // leftmost one (10.0.0.1, the attacker's own header content) -- that is
    // the entire point of trustProxy: 1 over trustProxy: true.
    const res = await app.inject({
      method: "GET",
      url: "/__whoami",
      headers: { "x-forwarded-for": "10.0.0.1, 203.0.113.77" },
    });
    expect(res.json()).toEqual({ ip: "203.0.113.77" });
    expect(res.json()).not.toEqual({ ip: "10.0.0.1" });
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
