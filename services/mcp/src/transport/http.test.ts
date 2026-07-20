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

function principal(tenantId: string, type: Principal["type"] = "agent"): Principal {
  return {
    id: type === "user" ? "user_01TEST0000000000000000" : AGENT_ID,
    type,
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
    const headerType = request.headers["x-test-principal-type"];
    const type =
      headerType === "user" || headerType === "api_partner" || headerType === "agent"
        ? headerType
        : "agent";
    if (typeof headerTenant === "string") {
      request.principal = principal(headerTenant, type);
    } else if (request.headers["x-test-skip-principal"] === "1") {
      // leave undefined to exercise the auth_token_missing branch
    } else {
      request.principal = principal(TENANT_A, type);
    }
  });
}

async function buildApp(opts: {
  tenantRateLimiter?: InMemorySlidingWindowRateLimiter;
  resourceMetadataUrl?: string;
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  await withFakeAuth(app);
  await registerMcpRoute(app, mockServer(), {
    ...(opts.tenantRateLimiter !== undefined ? { tenantRateLimiter: opts.tenantRateLimiter } : {}),
    ...(opts.resourceMetadataUrl !== undefined
      ? { resourceMetadataUrl: opts.resourceMetadataUrl }
      : {}),
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

  it("accepts user principals so human decision tools can use the MCP surface", async () => {
    const app = await buildApp({});
    try {
      const r = await app.inject({
        method: "POST",
        url: "/agents/mcp",
        headers: { "x-test-principal-type": "user", "content-type": "application/json" },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      });
      expect(r.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("rejects api_partner principals at the MCP boundary", async () => {
    const app = await buildApp({});
    try {
      const r = await app.inject({
        method: "POST",
        url: "/agents/mcp",
        headers: { "x-test-principal-type": "api_partner", "content-type": "application/json" },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      });
      expect(r.statusCode).toBe(403);
      const body = r.json() as { error: { code: string } };
      expect(body.error.code).toBe("auth_scope_insufficient");
    } finally {
      await app.close();
    }
  });
});

describe("registerMcpRoute — RFC 9728 WWW-Authenticate discovery", () => {
  const META_URL = "https://mcp.brain.fi/.well-known/oauth-protected-resource";

  it("attaches the resource_metadata challenge to a 401", async () => {
    const app = await buildApp({ resourceMetadataUrl: META_URL });
    try {
      const r = await app.inject({
        method: "POST",
        url: "/agents/mcp",
        headers: { "x-test-skip-principal": "1", "content-type": "application/json" },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      });
      expect(r.statusCode).toBe(401);
      expect(r.headers["www-authenticate"]).toBe(`Bearer resource_metadata="${META_URL}"`);
    } finally {
      await app.close();
    }
  });

  it("does not attach the challenge on a 200", async () => {
    const app = await buildApp({ resourceMetadataUrl: META_URL });
    try {
      const r = await app.inject({
        method: "POST",
        url: "/agents/mcp",
        headers: { "x-test-tenant": TENANT_A, "content-type": "application/json" },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      });
      expect(r.statusCode).toBe(200);
      expect(r.headers["www-authenticate"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("omits the header entirely when no metadata URL is configured", async () => {
    const app = await buildApp({});
    try {
      const r = await app.inject({
        method: "POST",
        url: "/agents/mcp",
        headers: { "x-test-skip-principal": "1", "content-type": "application/json" },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      });
      expect(r.statusCode).toBe(401);
      expect(r.headers["www-authenticate"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
