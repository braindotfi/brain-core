/**
 * Tests for the MCP Fastify route: principal_type enforcement and
 * per-tenant rate limiting.
 *
 * Uses Fastify's inject() so no network port is opened.
 */

import { describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import {
  InMemorySlidingWindowRateLimiter,
  errorHandlerPlugin,
  type Principal,
} from "@brain/shared";
import type { BrainMcpServer } from "../server.js";
import { registerMcpRoute } from "./http.js";

const TENANT_A = "tnt_01TESTAAAAAAAAAAAAAAAAAA";
const TENANT_B = "tnt_01TESTBBBBBBBBBBBBBBBBBB";
const AGENT_ID = "agent_01TEST00000000000000000";

function agentPrincipal(tenantId: string): Principal {
  return {
    id: AGENT_ID,
    type: "agent",
    tenantId,
    scopes: ["payment_intent:propose"] as unknown as Principal["scopes"],
    tokenId: "tok_01TEST00000000000000000",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

function mockServer(): BrainMcpServer {
  return {
    handle: vi.fn(async () => ({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [] },
    })),
  } as unknown as BrainMcpServer;
}

/** Fake auth plugin that stamps `request.principal` from an `x-test-tenant` header. */
async function withFakeAuth(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (request: FastifyRequest) => {
    const headerTenant = request.headers["x-test-tenant"];
    if (typeof headerTenant === "string") {
      request.principal = agentPrincipal(headerTenant);
    } else if (request.headers["x-test-skip-principal"] === "1") {
      // leave undefined to exercise the auth_token_missing branch
    } else {
      request.principal = agentPrincipal(TENANT_A);
    }
  });
}

async function buildApp(opts: {
  tenantRateLimiter?: InMemorySlidingWindowRateLimiter;
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  await withFakeAuth(app);
  await registerMcpRoute(app, mockServer(), {
    ...(opts.tenantRateLimiter !== undefined ? { tenantRateLimiter: opts.tenantRateLimiter } : {}),
  });
  return app;
}

describe("registerMcpRoute — per-tenant rate limit", () => {
  it("permits requests below the per-tenant limit", async () => {
    const limiter = new InMemorySlidingWindowRateLimiter({ windowSeconds: 60, limit: 3 });
    const app = await buildApp({ tenantRateLimiter: limiter });
    try {
      for (let i = 0; i < 3; i++) {
        const r = await app.inject({
          method: "POST",
          url: "/agents/mcp",
          headers: { "x-test-tenant": TENANT_A, "content-type": "application/json" },
          payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
        });
        expect(r.statusCode).toBe(200);
      }
    } finally {
      await app.close();
    }
  });

  it("rejects with rate_limited (HTTP 429) when the per-tenant cap is exceeded", async () => {
    const limiter = new InMemorySlidingWindowRateLimiter({ windowSeconds: 60, limit: 2 });
    const app = await buildApp({ tenantRateLimiter: limiter });
    try {
      // Two allowed, the third is over the cap.
      await app.inject({
        method: "POST",
        url: "/agents/mcp",
        headers: { "x-test-tenant": TENANT_A, "content-type": "application/json" },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      });
      await app.inject({
        method: "POST",
        url: "/agents/mcp",
        headers: { "x-test-tenant": TENANT_A, "content-type": "application/json" },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      });
      const third = await app.inject({
        method: "POST",
        url: "/agents/mcp",
        headers: { "x-test-tenant": TENANT_A, "content-type": "application/json" },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      });
      expect(third.statusCode).toBe(429);
      const body = third.json() as { error: { code: string; details: Record<string, unknown> } };
      expect(body.error.code).toBe("rate_limited");
      expect(body.error.details.tenant_id).toBe(TENANT_A);
      expect(body.error.details.limit).toBe(2);
    } finally {
      await app.close();
    }
  });

  it("keys the bucket per tenant — one tenant's flood does not affect another", async () => {
    // Limit=1 per window so any TENANT_A second call would 429.
    const limiter = new InMemorySlidingWindowRateLimiter({ windowSeconds: 60, limit: 1 });
    const app = await buildApp({ tenantRateLimiter: limiter });
    try {
      // TENANT_A uses up its quota.
      await app.inject({
        method: "POST",
        url: "/agents/mcp",
        headers: { "x-test-tenant": TENANT_A, "content-type": "application/json" },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      });
      const aSecond = await app.inject({
        method: "POST",
        url: "/agents/mcp",
        headers: { "x-test-tenant": TENANT_A, "content-type": "application/json" },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      });
      expect(aSecond.statusCode).toBe(429);

      // TENANT_B still has full quota.
      const bFirst = await app.inject({
        method: "POST",
        url: "/agents/mcp",
        headers: { "x-test-tenant": TENANT_B, "content-type": "application/json" },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      });
      expect(bFirst.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("does not apply the limiter when none is configured (backward-compat)", async () => {
    const app = await buildApp({});
    try {
      for (let i = 0; i < 5; i++) {
        const r = await app.inject({
          method: "POST",
          url: "/agents/mcp",
          headers: { "x-test-tenant": TENANT_A, "content-type": "application/json" },
          payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
        });
        expect(r.statusCode).toBe(200);
      }
    } finally {
      await app.close();
    }
  });
});

describe("registerMcpRoute — principal_type and missing-principal guards", () => {
  it("returns 401 when no principal is present", async () => {
    const app = await buildApp({});
    try {
      const r = await app.inject({
        method: "POST",
        url: "/agents/mcp",
        headers: { "x-test-skip-principal": "1", "content-type": "application/json" },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      });
      expect(r.statusCode).toBe(401);
      const body = r.json() as { error: { code: string } };
      expect(body.error.code).toBe("auth_token_missing");
    } finally {
      await app.close();
    }
  });
});
