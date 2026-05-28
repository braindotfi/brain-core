import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { InMemoryAuditEmitter, newTenantId, type ServiceCallContext } from "@brain/shared";
import { AgentService, type AgentServiceDeps } from "./AgentService.js";
import {
  UnconfiguredRegistrationRelayer,
  type AgentRegistrationRelayer,
} from "./registration-relayer.js";

const AGENT_ID = "agent_01J0000000000000000000000A";

function agentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: AGENT_ID,
    tenant_id: "tnt_x",
    kind: "external",
    role: "partner",
    display_name: "Partner Agent",
    scope_hash: Buffer.from("ab".repeat(32), "hex"),
    onchain_address: "0x" + "cd".repeat(20),
    state: "pending_onchain",
    registered_tx: null,
    registered_at: null,
    created_at: new Date(),
    ...overrides,
  };
}

/** Fake pool handling BEGIN/COMMIT/ROLLBACK/set_config + agents SELECT/UPDATE. */
function makeFakePool(handler: (sql: string) => { rows: unknown[]; rowCount: number }): {
  pool: Pool;
  sawUpdate: () => boolean;
} {
  let updateSeen = false;
  const client = {
    query: vi.fn((sql: string) => {
      if (
        sql === "BEGIN" ||
        sql === "COMMIT" ||
        sql === "ROLLBACK" ||
        sql.startsWith("SELECT set_config")
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (/UPDATE agents/.test(sql)) updateSeen = true;
      return Promise.resolve(handler(sql));
    }),
    release: vi.fn(),
  };
  return {
    pool: { connect: vi.fn(() => Promise.resolve(client)) } as unknown as Pool,
    sawUpdate: () => updateSeen,
  };
}

function makeDeps(
  pool: Pool,
  relayer?: AgentRegistrationRelayer,
): { deps: AgentServiceDeps; audit: InMemoryAuditEmitter } {
  const audit = new InMemoryAuditEmitter();
  const deps: AgentServiceDeps = {
    pool,
    audit,
    evaluatePolicy: vi.fn(), // unused by confirmRegistration
    ...(relayer !== undefined ? { relayer } : {}),
  };
  return { deps, audit };
}

const ctx: ServiceCallContext = { tenantId: newTenantId(), actor: "system" };

const okRelayer: AgentRegistrationRelayer = {
  configured: true,
  submitRegistration: vi.fn(async () => ({ txHash: "0xtx" })),
};

describe("AgentService.confirmRegistration — RFC 0002 Phase C", () => {
  it("promotes pending_onchain → active and records the tx + audit (configured relayer)", async () => {
    const { pool } = makeFakePool((sql) =>
      /UPDATE agents/.test(sql)
        ? { rows: [agentRow({ state: "active", registered_tx: "0xtx" })], rowCount: 1 }
        : { rows: [agentRow()], rowCount: 1 },
    );
    const { deps, audit } = makeDeps(pool, okRelayer);
    const rec = await new AgentService(deps).confirmRegistration(ctx, AGENT_ID);

    expect(rec.state).toBe("active");
    expect(rec.registered_tx).toBe("0xtx");
    expect(okRelayer.submitRegistration).toHaveBeenCalledTimes(1);
    expect(audit.events.map((e) => e.action)).toContain("agent.onchain_confirmed");
  });

  it("fails closed when NO relayer is configured (agent stays pending, no UPDATE)", async () => {
    const { pool, sawUpdate } = makeFakePool(() => ({ rows: [agentRow()], rowCount: 1 }));
    const { deps } = makeDeps(pool); // no relayer
    await expect(new AgentService(deps).confirmRegistration(ctx, AGENT_ID)).rejects.toMatchObject({
      code: "agent_rail_unavailable",
    });
    expect(sawUpdate()).toBe(false);
  });

  it("fails closed with the UnconfiguredRegistrationRelayer (no UPDATE, no submit)", async () => {
    const { pool, sawUpdate } = makeFakePool(() => ({ rows: [agentRow()], rowCount: 1 }));
    const { deps } = makeDeps(pool, new UnconfiguredRegistrationRelayer());
    await expect(new AgentService(deps).confirmRegistration(ctx, AGENT_ID)).rejects.toMatchObject({
      code: "agent_rail_unavailable",
    });
    expect(sawUpdate()).toBe(false);
  });

  it("rejects an unknown agent", async () => {
    const { pool } = makeFakePool(() => ({ rows: [], rowCount: 0 }));
    const { deps } = makeDeps(pool, okRelayer);
    await expect(new AgentService(deps).confirmRegistration(ctx, AGENT_ID)).rejects.toMatchObject({
      code: "agent_not_registered",
    });
  });

  it("rejects an agent that is not pending_onchain", async () => {
    const { pool, sawUpdate } = makeFakePool(() => ({
      rows: [agentRow({ state: "active" })],
      rowCount: 1,
    }));
    const { deps } = makeDeps(pool, okRelayer);
    await expect(new AgentService(deps).confirmRegistration(ctx, AGENT_ID)).rejects.toMatchObject({
      code: "agent_proposal_invalid_state",
    });
    expect(sawUpdate()).toBe(false);
  });
});
