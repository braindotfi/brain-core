/**
 * P0.3 — /wiki/annotate rate limiting.
 *
 * These exercise the route's limiter gate without a database: the limit check
 * runs BEFORE any Ledger/Wiki write, so a denied request never touches the
 * pool. A poison pool asserts that. The sliding-window timing (60 pass, 61st
 * denied, allow again after the window) is covered by the limiter's own unit
 * tests in shared/src/ratelimit/sliding-window.test.ts.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  InMemoryAuditEmitter,
  InMemorySlidingWindowRateLimiter,
  errorHandlerPlugin,
  newTenantId,
  newUserId,
  type Principal,
} from "@brain/shared";
import type { Pool } from "pg";
import { registerAnnotate } from "./annotate.js";
import type { WikiDeps } from "../deps.js";

const TENANT = newTenantId();
const ACTOR = newUserId();

const poisonPool = {
  connect: () => {
    throw new Error("DB must not be touched on the rate-limited path");
  },
} as unknown as Pool;

function principal(): Principal {
  return {
    id: ACTOR,
    type: "user",
    tenantId: TENANT,
    scopes: ["wiki:write"],
    tokenId: "tok_test",
    expiresAt: Math.floor(Date.now() / 1000) + 300,
  };
}

async function buildApp(deps: WikiDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  app.addHook("onRequest", async (req) => {
    req.principal = principal();
  });
  await registerAnnotate(app, deps);
  return app;
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  if (app !== undefined) await app.close();
  app = undefined;
});

describe("POST /wiki/annotate — rate limiting (P0.3)", () => {
  it("returns 429 with rate_limit_exceeded and emits wiki.annotation.rate_limited", async () => {
    const audit = new InMemoryAuditEmitter();
    const limiter = new InMemorySlidingWindowRateLimiter({ windowSeconds: 3600, limit: 1 });
    // Saturate the principal's window so the request below is the over-limit hit.
    await limiter.hit(`wiki:annotate:${TENANT}:${ACTOR}`);

    const deps = {
      pool: poisonPool,
      audit,
      annotationRateLimiter: limiter,
    } as unknown as WikiDeps;
    app = await buildApp(deps);

    const res = await app.inject({
      method: "POST",
      url: "/wiki/annotate",
      payload: { target: "entity", kind: "policy", attributes: {} },
    });

    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe("rate_limit_exceeded");
    const evt = audit.events.find((e) => e.action === "wiki.annotation.rate_limited");
    expect(evt).toBeDefined();
    expect(evt?.inputs.principal_id).toBe(ACTOR);
    expect(evt?.outputs.limit).toBe(1);
  });

  it("lets a within-limit request through the gate (reaches body validation, no DB)", async () => {
    const audit = new InMemoryAuditEmitter();
    const limiter = new InMemorySlidingWindowRateLimiter({ windowSeconds: 3600, limit: 60 });
    const deps = {
      pool: poisonPool,
      audit,
      annotationRateLimiter: limiter,
    } as unknown as WikiDeps;
    app = await buildApp(deps);

    // Missing target → body validation rejects (400), AFTER the limiter allows.
    const res = await app.inject({
      method: "POST",
      url: "/wiki/annotate",
      payload: { attributes: {} },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("request_body_invalid");
    // The limiter allowed it, so no rate-limited audit event was emitted.
    expect(audit.events.some((e) => e.action === "wiki.annotation.rate_limited")).toBe(false);
  });
});
