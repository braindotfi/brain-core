import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { InMemoryAuditEmitter, errorHandlerPlugin, newTenantId } from "@brain/shared";
import { registerGovernanceRoutes } from "./routes.js";

const platformSecret = "platform-secret";

interface QueryCall {
  sql: string;
  values?: readonly unknown[];
}

function agentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent_1",
    tenant_id: "tnt_test",
    kind: "internal",
    role: "payment",
    display_name: "Payment Agent",
    scope_hash: Buffer.from("aa".repeat(32), "hex"),
    onchain_address: null,
    state: "active",
    registered_tx: null,
    registered_at: new Date("2026-07-01T00:00:00.000Z"),
    created_at: new Date("2026-07-01T00:00:00.000Z"),
    ...overrides,
  };
}

function buildPool(
  opts: {
    agents?: unknown[];
    timeline?: unknown[];
    report?: unknown[];
    updateRows?: unknown[];
  } = {},
) {
  const calls: QueryCall[] = [];
  const client = {
    query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
      calls.push(values === undefined ? { sql } : { sql, values });
      if (
        sql === "BEGIN" ||
        sql === "COMMIT" ||
        sql === "ROLLBACK" ||
        sql.startsWith("SELECT set_config")
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("UPDATE agents")) {
        return {
          rows: opts.updateRows ?? [agentRow({ state: values?.[0] })],
          rowCount: opts.updateRows?.length ?? 1,
        };
      }
      if (sql.includes("FROM audit_events") && sql.includes("LEFT JOIN policy_decisions")) {
        return { rows: opts.report ?? [], rowCount: opts.report?.length ?? 0 };
      }
      if (sql.includes("FROM audit_events")) {
        return { rows: opts.timeline ?? [], rowCount: opts.timeline?.length ?? 0 };
      }
      if (sql.includes("FROM agents") && sql.includes("WHERE id = $1")) {
        return { rows: opts.agents ?? [agentRow()], rowCount: opts.agents?.length ?? 1 };
      }
      if (sql.includes("FROM agents")) {
        return { rows: opts.agents ?? [agentRow()], rowCount: opts.agents?.length ?? 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  return { calls, pool: { connect: vi.fn(async () => client) } as unknown as Pool };
}

async function build(
  opts: {
    agents?: unknown[];
    timeline?: unknown[];
    report?: unknown[];
    updateRows?: unknown[];
  } = {},
) {
  const app = Fastify();
  await app.register(errorHandlerPlugin);
  const db = buildPool(opts);
  const audit = new InMemoryAuditEmitter();
  await registerGovernanceRoutes(app, {
    pool: db.pool,
    audit,
    platformSecret,
  });
  return { app, db, audit };
}

describe("governance routes", () => {
  it("requires the platform service credential", async () => {
    const tenantId = newTenantId();
    const { app } = await build();
    const res = await app.inject({
      method: "GET",
      url: `/governance/agents?tenant_id=${tenantId}`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("auth_token_invalid");
    await app.close();
  });

  it("lists tenant-scoped agents with cursor pagination", async () => {
    const tenantId = newTenantId();
    const { app } = await build({
      agents: [
        agentRow({ id: "agent_1", tenant_id: tenantId }),
        agentRow({ id: "agent_2", tenant_id: tenantId }),
      ],
    });
    const res = await app.inject({
      method: "GET",
      url: `/governance/agents?tenant_id=${tenantId}&limit=1`,
      headers: { "x-platform-service-auth": platformSecret },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      agents: [{ id: "agent_1", status: "active", scopes: null }],
    });
    const cursor = res.json().next_cursor;
    expect(cursor).toBeTypeOf("string");
    const next = await app.inject({
      method: "GET",
      url: `/governance/agents?tenant_id=${tenantId}&cursor=${encodeURIComponent(cursor)}`,
      headers: { "x-platform-service-auth": platformSecret },
    });
    expect(next.statusCode).toBe(200);
    await app.close();
  });

  it("returns an empty agent page when owner filter does not match the tenant", async () => {
    const tenantId = newTenantId();
    const { app } = await build({
      agents: [agentRow({ id: "agent_1", tenant_id: tenantId })],
    });
    const res = await app.inject({
      method: "GET",
      url: `/governance/agents?tenant_id=${tenantId}&owner=other_owner`,
      headers: { "x-platform-service-auth": platformSecret },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ agents: [], next_cursor: null });
    await app.close();
  });

  it("passes status filters to the agent list query", async () => {
    const tenantId = newTenantId();
    const { app, db } = await build({
      agents: [agentRow({ id: "agent_1", tenant_id: tenantId, state: "quarantined" })],
    });
    const res = await app.inject({
      method: "GET",
      url: `/governance/agents?tenant_id=${tenantId}&status=quarantined`,
      headers: { "x-platform-service-auth": platformSecret },
    });
    expect(res.statusCode).toBe(200);
    const agentQuery = db.calls.find(
      (call) => call.sql.includes("FROM agents") && !call.sql.includes("WHERE id = $1"),
    );
    expect(agentQuery?.sql).toContain("state = $1");
    expect(agentQuery?.values).toContain("quarantined");
    await app.close();
  });

  it("writes an audit event for lifecycle transitions", async () => {
    const tenantId = newTenantId();
    const { app, audit } = await build({ agents: [agentRow({ tenant_id: tenantId })] });
    const res = await app.inject({
      method: "PATCH",
      url: "/governance/agents/agent_1",
      headers: { "x-platform-service-auth": platformSecret },
      payload: {
        tenant_id: tenantId,
        transition: "pause",
        reason: "manual review",
        actor: "user_admin",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().agent.status).toBe("quarantined");
    expect(audit.events[0]).toMatchObject({
      tenantId,
      layer: "agent",
      actor: "user_admin",
      action: "governance.agent.lifecycle_changed",
      inputs: {
        agent_id: "agent_1",
        transition: "pause",
        reason: "manual review",
        before_state: "active",
      },
      outputs: { after_state: "quarantined" },
    });
    await app.close();
  });

  it("returns agent detail with lifecycle timeline events", async () => {
    const tenantId = newTenantId();
    const { app } = await build({
      agents: [agentRow({ tenant_id: tenantId })],
      timeline: [
        {
          id: "evt_lifecycle",
          actor: "user_admin",
          action: "governance.agent.lifecycle_changed",
          inputs: { agent_id: "agent_1" },
          outputs: { after_state: "active" },
          policy_decision_id: null,
          policy_check_id: null,
          outcome: null,
          created_at: new Date("2026-07-01T00:00:00.000Z"),
        },
      ],
    });
    const res = await app.inject({
      method: "GET",
      url: `/governance/agents/agent_1?tenant_id=${tenantId}`,
      headers: { "x-platform-service-auth": platformSecret },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().agent.lifecycle_events[0]).toMatchObject({
      audit_event_id: "evt_lifecycle",
      actor: "user_admin",
      action: "governance.agent.lifecycle_changed",
      outputs: { after_state: "active" },
    });
    await app.close();
  });

  it("fails closed when an agent moves during lifecycle transition", async () => {
    const tenantId = newTenantId();
    const { app } = await build({
      agents: [agentRow({ tenant_id: tenantId })],
      updateRows: [],
    });
    const res = await app.inject({
      method: "PATCH",
      url: "/governance/agents/agent_1",
      headers: { "x-platform-service-auth": platformSecret },
      payload: {
        tenant_id: tenantId,
        transition: "revoke",
        reason: "manual review",
        actor: "user_admin",
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("execution_agent_not_registered");
    await app.close();
  });

  it("returns 404 when agent detail is missing", async () => {
    const tenantId = newTenantId();
    const { app } = await build({ agents: [] });
    const res = await app.inject({
      method: "GET",
      url: `/governance/agents/missing_agent?tenant_id=${tenantId}`,
      headers: { "x-platform-service-auth": platformSecret },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("agent_not_found");
    await app.close();
  });

  it("joins policy_decisions for historical report outcomes", async () => {
    const tenantId = newTenantId();
    const { app } = await build({
      report: [
        {
          id: "evt_1",
          actor: "agent_1",
          action: "payment_intent.execute.before",
          inputs: {},
          outputs: {},
          policy_decision_id: "pd_1",
          policy_check_id: null,
          outcome: null,
          native_policy_check_id: null,
          native_outcome: null,
          joined_policy_decision_id: "pd_1",
          joined_outcome: "reject",
          joined_policy_check_id: "rule_high_risk",
          created_at: new Date("2026-07-01T00:00:00.000Z"),
        },
      ],
    });
    const res = await app.inject({
      method: "GET",
      url:
        `/governance/reports?tenant_id=${tenantId}` +
        "&period_start=2026-07-01T00:00:00.000Z&period_end=2026-07-02T00:00:00.000Z",
      headers: { "x-platform-service-auth": platformSecret },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().summary.totals).toMatchObject({
      proposed: 1,
      blocked: 1,
      decision_data_unavailable: 0,
    });
    expect(res.json().events[0]).toMatchObject({
      audit_event_id: "evt_1",
      policy_decision_id: "pd_1",
      policy_check_id: "rule_high_risk",
      raw_policy_outcome: "reject",
      outcome: "blocked",
      decision_data_status: "available",
    });
    await app.close();
  });

  it("surfaces missing decision coverage instead of omitting rows", async () => {
    const tenantId = newTenantId();
    const { app } = await build({
      report: [
        {
          id: "evt_gap",
          actor: "agent_1",
          action: "agent.action.proposed",
          inputs: {},
          outputs: {},
          policy_decision_id: null,
          policy_check_id: null,
          outcome: null,
          native_policy_check_id: null,
          native_outcome: null,
          joined_policy_decision_id: null,
          joined_outcome: null,
          joined_policy_check_id: null,
          created_at: new Date("2026-07-01T00:00:00.000Z"),
        },
      ],
    });
    const res = await app.inject({
      method: "GET",
      url:
        `/governance/reports?tenant_id=${tenantId}` +
        "&period_start=2026-07-01T00:00:00.000Z&period_end=2026-07-02T00:00:00.000Z",
      headers: { "x-platform-service-auth": platformSecret },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().summary.totals.decision_data_unavailable).toBe(1);
    expect(res.json().events[0]).toMatchObject({
      audit_event_id: "evt_gap",
      outcome: null,
      decision_data_status: "unavailable",
      unavailable_reason: "policy_decision_id_missing",
    });
    await app.close();
  });

  it("uses native outcomes and agent ids from payload fields in reports", async () => {
    const tenantId = newTenantId();
    const { app } = await build({
      report: [
        {
          id: "evt_native",
          actor: "user_1",
          action: "agent.action.proposed",
          inputs: { agent_id: "agent_from_input" },
          outputs: {},
          policy_decision_id: null,
          policy_check_id: "rule_review",
          outcome: "confirm",
          native_policy_check_id: "rule_review",
          native_outcome: "confirm",
          joined_policy_decision_id: null,
          joined_outcome: null,
          joined_policy_check_id: null,
          created_at: new Date("2026-07-01T00:00:00.000Z"),
        },
      ],
    });
    const res = await app.inject({
      method: "GET",
      url:
        `/governance/reports?tenant_id=${tenantId}` +
        "&period_start=2026-07-01T00:00:00.000Z&period_end=2026-07-02T00:00:00.000Z",
      headers: { "x-platform-service-auth": platformSecret },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().summary.totals).toMatchObject({
      escalated: 1,
      decision_data_unavailable: 0,
    });
    expect(res.json().events[0]).toMatchObject({
      audit_event_id: "evt_native",
      agent_id: "agent_from_input",
      policy_check_id: "rule_review",
      raw_policy_outcome: "confirm",
      outcome: "escalated",
      decision_data_status: "available",
    });
    await app.close();
  });

  it("passes agent_id as a report filter", async () => {
    const tenantId = newTenantId();
    const { app, db } = await build({ report: [] });
    const res = await app.inject({
      method: "GET",
      url:
        `/governance/reports?tenant_id=${tenantId}` +
        "&period_start=2026-07-01T00:00:00.000Z&period_end=2026-07-02T00:00:00.000Z&agent_id=agent_1",
      headers: { "x-platform-service-auth": platformSecret },
    });
    expect(res.statusCode).toBe(200);
    const reportQuery = db.calls.find(
      (call) => call.sql.includes("FROM audit_events") && call.sql.includes("LEFT JOIN"),
    );
    expect(reportQuery?.sql).toContain("ae.actor = $3");
    expect(reportQuery?.values).toContain("agent_1");
    await app.close();
  });

  it("rejects invalid report windows and formats", async () => {
    const tenantId = newTenantId();
    const { app } = await build();
    const inverted = await app.inject({
      method: "GET",
      url:
        `/governance/reports?tenant_id=${tenantId}` +
        "&period_start=2026-07-02T00:00:00.000Z&period_end=2026-07-01T00:00:00.000Z",
      headers: { "x-platform-service-auth": platformSecret },
    });
    expect(inverted.statusCode).toBe(400);
    expect(inverted.json().error.message).toContain("period_end");
    const invalidFormat = await app.inject({
      method: "GET",
      url:
        `/governance/reports?tenant_id=${tenantId}` +
        "&period_start=2026-07-01T00:00:00.000Z&period_end=2026-07-02T00:00:00.000Z&format=xlsx",
      headers: { "x-platform-service-auth": platformSecret },
    });
    expect(invalidFormat.statusCode).toBe(400);
    expect(invalidFormat.json().error.message).toContain("format");
    await app.close();
  });

  it("renders governance reports as CSV with escaped cells", async () => {
    const tenantId = newTenantId();
    const { app } = await build({
      report: [
        {
          id: "evt_csv",
          actor: 'user_"admin"',
          action: "agent.action.proposed",
          inputs: {},
          outputs: { agent_id: "agent_from_output", outcome: "allow" },
          policy_decision_id: null,
          policy_check_id: null,
          outcome: null,
          native_policy_check_id: null,
          native_outcome: null,
          joined_policy_decision_id: null,
          joined_outcome: null,
          joined_policy_check_id: null,
          created_at: new Date("2026-07-01T00:00:00.000Z"),
        },
      ],
    });
    const res = await app.inject({
      method: "GET",
      url:
        `/governance/reports?tenant_id=${tenantId}` +
        "&period_start=2026-07-01T00:00:00.000Z&period_end=2026-07-02T00:00:00.000Z&format=csv",
      headers: { "x-platform-service-auth": platformSecret },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.body.split("\n")[0]).toBe(
      "audit_event_id,created_at,actor,agent_id,action,policy_decision_id,policy_check_id,raw_policy_outcome,outcome,decision_data_status,unavailable_reason",
    );
    expect(res.body).toContain('"user_""admin"""');
    expect(res.body).toContain("agent_from_output");
    expect(res.body).toContain("approved");
    await app.close();
  });
});
