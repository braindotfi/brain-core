/**
 * The legacy POST /execution/mcp is a deprecated v0.2 ping-only shim. `ping`
 * still answers (back-compat for the v0.3 transition window), but any other
 * method now points callers at the real MCP surface (POST /v1/agents/mcp,
 * services/mcp) instead of a bare "not implemented". This locks both behaviors
 * so the shim can't silently regress into looking like an unbuilt surface.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { errorHandlerPlugin, requestIdPlugin, type Principal, type Scope } from "@brain/shared";
import type { Pool } from "pg";
import { registerExecutionRoutes } from "./routes.js";
import { RailRegistry } from "./rails/stubs.js";
import type { ExecutionDeps } from "./deps.js";

const TENANT = "tnt_01TEST00000000000000000000";

function principal(type: Principal["type"], scopes: Scope[] = []): Principal {
  return {
    id: type === "agent" ? "agent_01TEST0000000000000000000" : "usr_01TEST0000000000000000000",
    type,
    tenantId: TENANT,
    scopes,
    tokenId: "tok_01TEST0000000000000000000",
    expiresAt: Math.floor(Date.now() / 1000) + 900,
  };
}

function fakeDeps(): ExecutionDeps {
  const unused = () => {
    throw new Error("dependency must not be used by /execution/mcp");
  };
  return {
    pool: { connect: unused } as unknown as Pool,
    audit: { emit: vi.fn(async () => undefined) } as unknown as ExecutionDeps["audit"],
    rails: new RailRegistry([]),
    evaluatePolicy: unused as unknown as ExecutionDeps["evaluatePolicy"],
    evaluatePaymentIntent: unused as unknown as ExecutionDeps["evaluatePaymentIntent"],
    resolveAgent: unused as unknown as ExecutionDeps["resolveAgent"],
    resolveAccount: unused as unknown as ExecutionDeps["resolveAccount"],
    resolveCounterparty: unused as unknown as ExecutionDeps["resolveCounterparty"],
    resolvePrincipal: unused as unknown as ExecutionDeps["resolvePrincipal"],
    resolveRole: unused as unknown as ExecutionDeps["resolveRole"],
  };
}

async function buildApp(p: Principal): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(requestIdPlugin);
  await app.register(errorHandlerPlugin);
  app.addHook("preHandler", async (req) => {
    req.principal = p;
  });
  await registerExecutionRoutes(app, fakeDeps());
  return app;
}

async function callMcp(p: Principal, body: Record<string, unknown>) {
  const app = await buildApp(p);
  const res = await app.inject({
    method: "POST",
    url: "/execution/mcp",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify(body),
  });
  await app.close();
  return res;
}

describe("POST /execution/mcp (deprecated v0.2 shim)", () => {
  it("ping still answers for back-compat", async () => {
    const res = await callMcp(principal("agent"), { method: "ping" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("any other method is deprecated and points at /v1/agents/mcp", async () => {
    const res = await callMcp(principal("agent"), { method: "wiki.query" });
    expect(res.statusCode).toBe(501);
    expect(res.json().error.message).toMatch(/\/v1\/agents\/mcp/);
    expect(res.json().error.message).toMatch(/deprecated/);
  });

  it("still rejects a non-agent principal", async () => {
    const res = await callMcp(principal("user"), { method: "ping" });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("auth_scope_insufficient");
  });
});
