import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { errorHandlerPlugin, requestIdPlugin, type Principal, type Scope } from "@brain/shared";
import type { Pool } from "pg";
import { registerExecutionRoutes } from "./routes.js";
import { RailRegistry } from "./rails/stubs.js";
import type { Rail } from "./rails/types.js";
import type { ExecutionDeps } from "./deps.js";

const TENANT = "tnt_01TEST00000000000000000000";

function principal(scopes: Scope[]): Principal {
  return {
    id: "agent_01TEST0000000000000000000",
    type: "agent",
    tenantId: TENANT,
    scopes,
    tokenId: "tok_01TEST0000000000000000000",
    expiresAt: Math.floor(Date.now() / 1000) + 900,
  };
}

/**
 * A fake pg pool that satisfies the legacy /execution/execute flow:
 * findProposal returns an APPROVED proposal, the executions writes succeed.
 * If the route reaches rail dispatch, money moves — which is exactly the
 * §6 bypass this test guards against.
 */
function fakePool(): Pool {
  const proposalRow = {
    id: "prp_01TEST0000000000000000000",
    status: "approved",
    action: { kind: "wire", amount: "100000.00", currency: "USD" },
  };
  const execRow = {
    id: "exec_01TEST000000000000000000",
    proposal_id: proposalRow.id,
    rail: "bank_ach",
    rail_receipt: null,
    status: "in_flight",
    started_at: new Date(),
    completed_at: null,
    idempotency_key: "k",
  };
  const client = {
    query: async (text: string) => {
      const t = text.toUpperCase();
      if (t.includes("PROPOSALS")) return { rows: [proposalRow], rowCount: 1 };
      if (t.includes("EXECUTIONS")) return { rows: [execRow], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  return { connect: async () => client } as unknown as Pool;
}

function fakeDeps(rails: RailRegistry, pool: Pool): ExecutionDeps {
  const unused = () => {
    throw new Error("dependency must not be used by /execution/execute");
  };
  return {
    pool,
    audit: { emit: vi.fn(async () => undefined) } as unknown as ExecutionDeps["audit"],
    rails,
    evaluatePolicy: unused as unknown as ExecutionDeps["evaluatePolicy"],
    evaluatePaymentIntent: unused as unknown as ExecutionDeps["evaluatePaymentIntent"],
    resolveAgent: unused as unknown as ExecutionDeps["resolveAgent"],
    resolveAccount: unused as unknown as ExecutionDeps["resolveAccount"],
    resolveCounterparty: unused as unknown as ExecutionDeps["resolveCounterparty"],
    resolvePrincipal: unused as unknown as ExecutionDeps["resolvePrincipal"],
    resolveRole: unused as unknown as ExecutionDeps["resolveRole"],
  };
}

async function buildApp(deps: ExecutionDeps, scopes: Scope[]): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(requestIdPlugin);
  await app.register(errorHandlerPlugin);
  app.addHook("preHandler", async (req) => {
    req.principal = principal(scopes);
  });
  await registerExecutionRoutes(app, deps);
  return app;
}

describe("POST /execution/execute (legacy)", () => {
  it("refuses to settle money — it bypasses the §6 pre-execution gate", async () => {
    const dispatch = vi.fn<Rail["dispatch"]>(async () => ({ receipt: { stub: true } }));
    const rail: Rail = { kind: "bank_ach", dispatch };
    const deps = fakeDeps(new RailRegistry([rail]), fakePool());
    const app = await buildApp(deps, ["execution:write"]);

    const res = await app.inject({
      method: "POST",
      url: "/execution/execute",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ proposal_id: "prp_01TEST0000000000000000000", rail: "bank_ach" }),
    });

    // The security property: no rail dispatch may happen on this path.
    expect(dispatch).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("gate_no_policy_decision");

    await app.close();
  });

  it("still enforces auth scope before refusing", async () => {
    const dispatch = vi.fn<Rail["dispatch"]>(async () => ({ receipt: { stub: true } }));
    const deps = fakeDeps(new RailRegistry([{ kind: "bank_ach", dispatch }]), fakePool());
    const app = await buildApp(deps, ["execution:read"]);

    const res = await app.inject({
      method: "POST",
      url: "/execution/execute",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ proposal_id: "prp_01TEST0000000000000000000", rail: "bank_ach" }),
    });

    expect(dispatch).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("auth_scope_insufficient");

    await app.close();
  });
});
