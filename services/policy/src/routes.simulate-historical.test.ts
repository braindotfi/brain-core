/**
 * POST /policy/:tenant_id/simulate-historical -- row cap (H-P2-5).
 *
 * The DB fetch used to run with no LIMIT on the request thread, holding
 * every row in memory; a wide period on a busy tenant was an unbounded
 * allocation reachable by any caller with policy:read. These tests prove the
 * cap is enforced and that the response tells the caller the replay was
 * partial rather than silently covering only part of the requested period.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { errorHandlerPlugin, requestIdPlugin, type Principal, type Scope } from "@brain/shared";
import type { Pool } from "pg";
import { registerPolicyRoutes } from "./routes.js";
import type { PolicyDeps } from "./deps.js";

const TENANT = "tnt_01TEST00000000000000000000";
const REGISTRY = "0x1111111111111111111111111111111111111111" as const;
const CHAIN_ID = 84532;

const CANDIDATE_CONTENT = {
  version: 1,
  rules: [{ id: "default-reject", applies_to: ["any"], when: {}, execute: "reject" }],
};

function ledgerRow(i: number): Record<string, unknown> {
  return {
    id: `pi_${i}`,
    action_type: "ach_outbound",
    amount: "10.00",
    currency: "USD",
    destination_counterparty_id: "cp_1",
    created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
  };
}

function fakePool(ledgerRowCount: number): Pool {
  const client = {
    query: async (sql: string) => {
      if (sql.includes("FROM ledger_payment_intents")) {
        const rows = Array.from({ length: ledgerRowCount }, (_, i) => ledgerRow(i));
        return { rows, rowCount: rows.length };
      }
      if (sql.includes("state = 'active'")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  return { connect: async () => client } as unknown as Pool;
}

function buildDeps(ledgerRowCount: number): PolicyDeps {
  return {
    pool: fakePool(ledgerRowCount),
    audit: { emit: vi.fn(async () => undefined) } as unknown as PolicyDeps["audit"],
    chainId: CHAIN_ID,
    policyRegistryAddress: REGISTRY,
    isAuthorizedSigner: async () => true,
  };
}

function principal(): Principal {
  return {
    id: "user_01TEST000000000000000000",
    type: "user",
    tenantId: TENANT,
    scopes: ["policy:read"] as Scope[],
    tokenId: "tok_01TEST0000000000000000000",
    expiresAt: Math.floor(Date.now() / 1000) + 900,
  };
}

async function buildApp(deps: PolicyDeps): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(requestIdPlugin);
  await app.register(errorHandlerPlugin);
  app.addHook("preHandler", async (req) => {
    req.principal = principal();
  });
  await registerPolicyRoutes(app, deps);
  return app;
}

function postSimulateHistorical(app: FastifyInstance) {
  return app.inject({
    method: "POST",
    url: `/policy/${TENANT}/simulate-historical`,
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({
      policy_content: CANDIDATE_CONTENT,
      period_start: "2026-01-01T00:00:00.000Z",
      period_end: "2026-01-02T00:00:00.000Z",
    }),
  });
}

describe("POST /policy/:tenant_id/simulate-historical row cap", () => {
  it("does not truncate when the period has fewer rows than the cap", async () => {
    const app = await buildApp(buildDeps(3));
    const res = await postSimulateHistorical(app);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.truncated).toBe(false);
    expect(body.replayed).toBe(3);
    expect(body.total).toBe(3);
    await app.close();
  });

  it("caps the replay at 5000 and reports truncated: true when more rows exist", async () => {
    const app = await buildApp(buildDeps(5001));
    const res = await postSimulateHistorical(app);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.truncated).toBe(true);
    expect(body.replayed).toBe(5000);
    expect(body.total).toBe(5000);
    await app.close();
  });
});
