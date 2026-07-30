import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  computeAgentScopeHash,
  errorHandlerPlugin,
  newAgentId,
  newTenantId,
  requestIdPlugin,
  type Principal,
} from "@brain/shared";
import { scopesForAgentRole } from "@brain/internal-agents";
import type { Pool } from "pg";
import type { ExecutionDeps } from "./deps.js";
import { RailRegistry } from "./rails/stubs.js";
import { registerExecutionRoutes } from "./routes.js";

const TENANT = newTenantId();
const AUTH_AGENT = newAgentId();

function adminPrincipal(): Principal {
  return {
    id: AUTH_AGENT,
    type: "agent",
    tenantId: TENANT,
    scopes: ["execution:admin"],
    tokenId: "tok_01TEST0000000000000000000",
    expiresAt: Math.floor(Date.now() / 1000) + 900,
  };
}

async function buildApp(deps: ExecutionDeps): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(requestIdPlugin);
  await app.register(errorHandlerPlugin);
  app.addHook("preHandler", async (request) => {
    request.principal = adminPrincipal();
  });
  await app.register(async (child) => registerExecutionRoutes(child, deps));
  return app;
}

/** A pool whose withTenantScope-driven client answers INSERT INTO agents
 *  by echoing the inserted row back (RETURNING *), mirroring the real
 *  repository.insertAgent shape closely enough for route-level assertions. */
function agentInsertingDeps(): ExecutionDeps {
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (sql.startsWith("SELECT set_config")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("INSERT INTO agents")) {
        return {
          rows: [
            {
              id: values[0],
              tenant_id: values[1],
              kind: values[2],
              role: values[3],
              display_name: values[4],
              scope_hash: values[5],
              onchain_address: values[6],
              state: values[7],
              registered_tx: values[8],
              registered_at: values[9],
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  const unused = () => {
    throw new Error("dependency must not be used by agent-registration tests");
  };
  return {
    pool: { connect: async () => client } as unknown as Pool,
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

describe("POST /execution/agents/register — scope_hash canonicality", () => {
  it("rejects a non-canonical scope_hash for the supplied role", async () => {
    const app = await buildApp(agentInsertingDeps());
    const res = await app.inject({
      method: "POST",
      url: "/execution/agents/register",
      payload: {
        agent_id: newAgentId(),
        role: "payment",
        display_name: "Malicious Agent",
        scope_hash: "ab".repeat(32),
      },
    });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: { code: string } }).error.code).toBe(
      "agent_scope_hash_mismatch",
    );
    await app.close();
  });

  it("accepts the canonical scope_hash for the supplied role", async () => {
    const app = await buildApp(agentInsertingDeps());
    const canonical = computeAgentScopeHash(scopesForAgentRole("payment")).slice(2);
    const res = await app.inject({
      method: "POST",
      url: "/execution/agents/register",
      payload: {
        agent_id: newAgentId(),
        role: "payment",
        display_name: "Real Agent",
        scope_hash: canonical,
      },
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { scope_hash: string }).scope_hash).toBe(canonical);
    await app.close();
  });

  it("still accepts an omitted scope_hash (stores null, unchanged contract)", async () => {
    const app = await buildApp(agentInsertingDeps());
    const res = await app.inject({
      method: "POST",
      url: "/execution/agents/register",
      payload: {
        agent_id: newAgentId(),
        role: "payment",
        display_name: "Pending Agent",
      },
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { scope_hash: string | null }).scope_hash).toBeNull();
    await app.close();
  });
});
