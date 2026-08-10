import { describe, it, expect, vi } from "vitest";
import { AgentService } from "./AgentService.js";
import type { AgentServiceDeps } from "./AgentService.js";
import { InMemoryAuditEmitter, newTenantId, newAgentId, newProposalId } from "@brain/shared";
import type { ServiceCallContext } from "@brain/shared";
import type { Pool } from "pg";

// ---------------------------------------------------------------------------
// Constants — valid Brain IDs generated at module load
// ---------------------------------------------------------------------------

const TENANT = newTenantId();
const AGENT_ID = newAgentId();

const ctx: ServiceCallContext = {
  tenantId: TENANT,
  actor: AGENT_ID,
  requestId: "req_test",
  principalType: "agent",
  scopes: ["execution:propose"],
};

// ---------------------------------------------------------------------------
// Fake pool — handles BEGIN/COMMIT/ROLLBACK/set_config transparently
// ---------------------------------------------------------------------------

function makeFakePool(
  queryFn: (sql: string, values: unknown[]) => { rows: unknown[]; rowCount: number },
): Pool {
  const client = {
    query: vi.fn((sql: string, values?: unknown[]) => {
      if (
        sql === "BEGIN" ||
        sql === "COMMIT" ||
        sql === "ROLLBACK" ||
        sql.startsWith("SELECT set_config")
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      return Promise.resolve(queryFn(sql, values ?? []));
    }),
    release: vi.fn(),
  };
  return { connect: vi.fn(() => Promise.resolve(client)) } as unknown as Pool;
}

function makeProposalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: newProposalId(),
    tenant_id: TENANT,
    proposing_agent: AGENT_ID,
    action: { kind: "flag_anomaly", mode: "propose" },
    policy_version: 1,
    policy_decision: "allow",
    policy_trace: [],
    required_approvers: [],
    status: "approved",
    approvers_signed: [],
    created_at: new Date(),
    ...overrides,
  };
}

function makeEvaluatePolicy(outcome: "allow" | "confirm" | "reject" = "allow") {
  return vi.fn().mockResolvedValue({
    outcome,
    matched_rule_id: "auto-agent-action",
    required_approvers: [],
    trace: [],
    policy_version: 1,
  });
}

function makeDeps(
  outcome: "allow" | "confirm" | "reject" = "allow",
  poolQueryFn?: (sql: string, values: unknown[]) => { rows: unknown[]; rowCount: number },
  overrides: Partial<AgentServiceDeps> = {},
): AgentServiceDeps {
  const row = makeProposalRow({
    status: outcome === "allow" ? "approved" : outcome === "confirm" ? "pending" : "rejected",
  });
  const defaultQuery = () => ({ rows: [row], rowCount: 1 });
  return {
    pool: makeFakePool(poolQueryFn ?? defaultQuery),
    audit: new InMemoryAuditEmitter(),
    evaluatePolicy: makeEvaluatePolicy(outcome),
    resolveAgentAuthority: async () => "propose" as const,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentService.propose", () => {
  it("maps allow → approved", async () => {
    const svc = new AgentService(makeDeps("allow"));
    const result = await svc.propose(ctx, AGENT_ID, { action: { kind: "flag_anomaly" } });
    expect(result.status).toBe("approved");
    expect(result.proposing_agent_id).toBe(AGENT_ID);
  });

  it("maps confirm → pending", async () => {
    const svc = new AgentService(makeDeps("confirm"));
    const result = await svc.propose(ctx, AGENT_ID, {
      action: { kind: "recommend_obligation", description: "recurring charge" },
    });
    expect(result.status).toBe("pending");
  });

  it("maps reject → rejected", async () => {
    const svc = new AgentService(makeDeps("reject"));
    const result = await svc.propose(ctx, AGENT_ID, { action: { kind: "flag_anomaly" } });
    expect(result.status).toBe("rejected");
  });

  it("defaults action.kind to agent_action when omitted", async () => {
    const deps = makeDeps("allow");
    const svc = new AgentService(deps);
    await svc.propose(ctx, AGENT_ID, { action: { description: "no kind" } });
    expect(deps.evaluatePolicy).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ kind: "agent_action" }),
    );
  });

  it("preserves explicit action.kind", async () => {
    const deps = makeDeps("allow");
    const svc = new AgentService(deps);
    await svc.propose(ctx, AGENT_ID, { action: { kind: "reconciliation_match" } });
    expect(deps.evaluatePolicy).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ kind: "reconciliation_match" }),
    );
  });

  it("does not let a propose-authority agent self-assert notify_only mode", async () => {
    const deps = makeDeps("allow", undefined, {
      resolveAgentAuthority: async () => "propose" as const,
    });
    const svc = new AgentService(deps);
    await svc.propose(ctx, AGENT_ID, {
      action: { kind: "flag_anomaly", mode: "notify_only" },
    });
    expect(deps.evaluatePolicy).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ mode: "propose" }),
    );
  });

  it("stamps notify_only from trusted agent authority and keeps the proposal pending", async () => {
    const deps = makeDeps(
      "allow",
      () => ({
        rows: [
          makeProposalRow({
            status: "pending",
            action: { kind: "flag_anomaly", mode: "notify_only" },
          }),
        ],
        rowCount: 1,
      }),
      {
        resolveAgentAuthority: async () => "notify_only" as const,
      },
    );
    const svc = new AgentService(deps);
    const result = await svc.propose(ctx, AGENT_ID, {
      action: { kind: "flag_anomaly", mode: "propose" },
    });
    expect(deps.evaluatePolicy).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ mode: "notify_only" }),
    );
    expect(result.status).toBe("pending");
  });

  it("defaults unresolved agent authority to notify_only and keeps allow outcomes pending", async () => {
    const deps = makeDeps(
      "allow",
      () => ({
        rows: [
          makeProposalRow({
            status: "pending",
            action: { kind: "flag_anomaly", mode: "notify_only" },
          }),
        ],
        rowCount: 1,
      }),
      {
        resolveAgentAuthority: async () => null,
      },
    );
    const svc = new AgentService(deps);
    const result = await svc.propose(ctx, AGENT_ID, {
      action: { kind: "flag_anomaly", mode: "propose" },
    });
    expect(deps.evaluatePolicy).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ mode: "notify_only" }),
    );
    expect(result.status).toBe("pending");
  });

  it("emits agent.action.proposed audit event", async () => {
    const deps = makeDeps("allow");
    const svc = new AgentService(deps);
    await svc.propose(ctx, AGENT_ID, { action: { kind: "suggest_categorization" } });
    const emitter = deps.audit as InMemoryAuditEmitter;
    const events = emitter.events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "agent.action.proposed",
      layer: "agent",
      actor: AGENT_ID,
    });
  });

  it("refreshes the pending Collections proposal for an invoice instead of inserting another", async () => {
    const queries: string[] = [];
    let inserted = false;
    let proposal = makeProposalRow({
      proposing_agent: "collections",
      status: "pending",
      action: { type: "collections", invoice_id: "inv_123", days_overdue: 18 },
    });
    const deps = makeDeps("confirm", (sql, values) => {
      queries.push(sql);
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
      if (sql.includes("FROM proposals") && sql.includes("FOR UPDATE")) {
        return inserted ? { rows: [proposal], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (sql.startsWith("INSERT INTO proposals")) {
        inserted = true;
        proposal = {
          ...proposal,
          id: String(values[0]),
          action: JSON.parse(String(values[3])),
        };
        return { rows: [proposal], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE proposals")) {
        proposal = { ...proposal, action: JSON.parse(String(values[1])) };
        return { rows: [proposal], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const svc = new AgentService(deps);

    const first = await svc.propose(ctx, "collections", {
      action: { type: "collections", invoice_id: "inv_123", days_overdue: 18 },
    });
    const second = await svc.propose(ctx, "collections", {
      action: { type: "collections", invoice_id: "inv_123", days_overdue: 19 },
    });

    expect(second.id).toBe(first.id);
    expect(queries.filter((sql) => sql.startsWith("INSERT INTO proposals"))).toHaveLength(1);
    expect(queries.filter((sql) => sql.startsWith("UPDATE proposals"))).toHaveLength(1);
    expect(proposal.action).toMatchObject({ invoice_id: "inv_123", days_overdue: 19 });
    expect((deps.audit as InMemoryAuditEmitter).events).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: "agent.action.refreshed" })]),
    );
  });

  it("does not apply the Collections invoice refresh path to another agent", async () => {
    const queries: string[] = [];
    const deps = makeDeps("confirm", (sql) => {
      queries.push(sql);
      return { rows: [makeProposalRow({ status: "pending" })], rowCount: 1 };
    });
    const svc = new AgentService(deps);

    await svc.propose(ctx, "cash_forecast", {
      action: { type: "cash_forecast", invoice_id: "inv_123" },
    });

    expect(queries.some((sql) => sql.includes("pg_advisory_xact_lock"))).toBe(false);
    expect(queries.filter((sql) => sql.startsWith("INSERT INTO proposals"))).toHaveLength(1);
  });

  it("returns a proposal with the full action and timestamps", async () => {
    const svc = new AgentService(makeDeps("allow"));
    const action = { kind: "flag_anomaly", tx_id: "tx_abc", reason: "duplicate" };
    const result = await svc.propose(ctx, AGENT_ID, { action });
    expect(result.action).toMatchObject(action);
    expect(result.id).toMatch(/^prop_/);
    expect(result.created_at).toBeTruthy();
  });
});
