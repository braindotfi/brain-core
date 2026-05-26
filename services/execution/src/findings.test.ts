/**
 * Unit tests for the agent_findings repository (fix/main-green). A substring-
 * routed fake TenantScopedClient stands in for Postgres.
 */

import { describe, expect, it, vi } from "vitest";
import type { TenantScopedClient } from "@brain/shared";
import {
  insertFinding,
  insertFindingOverride,
  listFindingsByAgent,
  listOverridesByAgent,
  type AgentFindingOverrideRow,
  type AgentFindingRow,
} from "./findings.js";

function client(handler: (sql: string, params: unknown[]) => { rows: unknown[] }): {
  c: TenantScopedClient;
  calls: { sql: string; params: unknown[] }[];
} {
  const calls: { sql: string; params: unknown[] }[] = [];
  const c = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return handler(sql, params);
    }),
  } as unknown as TenantScopedClient;
  return { c, calls };
}

const findingRow: AgentFindingRow = {
  id: "afnd_1",
  tenant_id: "tnt_x",
  agent_id: "agent_1",
  finding_kind: "vendor_risk",
  severity: "high",
  rule_id: null,
  rule_catalog_version: null,
  subject_type: null,
  subject_id: null,
  detail: {},
  status: "open",
  created_at: new Date(),
};

describe("findings repository", () => {
  it("insertFinding inserts with defaults and returns the row", async () => {
    const { c, calls } = client(() => ({ rows: [findingRow] }));
    const out = await insertFinding(c, {
      id: "afnd_1",
      tenantId: "tnt_x",
      agentId: "agent_1",
      findingKind: "vendor_risk",
      severity: "high",
    });
    expect(out.id).toBe("afnd_1");
    const p = calls[0]!.params;
    expect(p[5]).toBeNull(); // rule_id default
    expect(p[9]).toBe("{}"); // detail default JSON
  });

  it("insertFinding passes through optional fields", async () => {
    const { c, calls } = client(() => ({ rows: [findingRow] }));
    await insertFinding(c, {
      id: "afnd_2",
      tenantId: "tnt_x",
      agentId: "agent_1",
      findingKind: "compliance",
      severity: "critical",
      ruleId: "r1",
      ruleCatalogVersion: "v2",
      subjectType: "payment_intent",
      subjectId: "pi_1",
      detail: { note: "x" },
    });
    const p = calls[0]!.params;
    expect(p[5]).toBe("r1");
    expect(p[9]).toBe(JSON.stringify({ note: "x" }));
  });

  it("insertFinding throws when no row is returned", async () => {
    const { c } = client(() => ({ rows: [] }));
    await expect(
      insertFinding(c, { id: "x", tenantId: "t", agentId: "a", findingKind: "k", severity: "low" }),
    ).rejects.toThrow(/no row/);
  });

  it("listFindingsByAgent clamps the limit to [1,500]", async () => {
    const { c, calls } = client(() => ({ rows: [findingRow] }));
    await listFindingsByAgent(c, "agent_1", 9999);
    expect(calls[0]!.params[1]).toBe(500);
    await listFindingsByAgent(c, "agent_1", 0);
    expect(calls[1]!.params[1]).toBe(1);
    await listFindingsByAgent(c, "agent_1"); // default 100
    expect(calls[2]!.params[1]).toBe(100);
  });

  it("insertFindingOverride inserts the override AND flips the finding to overridden", async () => {
    const overrideRow: AgentFindingOverrideRow = {
      id: "afov_1",
      tenant_id: "tnt_x",
      finding_id: "afnd_1",
      agent_id: "agent_1",
      overridden_by: "user_root",
      reason: "documented",
      created_at: new Date(),
    };
    const { c, calls } = client((sql) =>
      sql.includes("INSERT INTO agent_finding_overrides") ? { rows: [overrideRow] } : { rows: [] },
    );
    const out = await insertFindingOverride(c, {
      id: "afov_1",
      tenantId: "tnt_x",
      findingId: "afnd_1",
      agentId: "agent_1",
      overriddenBy: "user_root",
      reason: "documented",
    });
    expect(out.id).toBe("afov_1");
    const update = calls.find((q) => q.sql.includes("UPDATE agent_findings SET status = 'overridden'"))!;
    expect(update.params).toEqual(["afnd_1"]);
  });

  it("insertFindingOverride throws when no override row is returned", async () => {
    const { c } = client(() => ({ rows: [] }));
    await expect(
      insertFindingOverride(c, {
        id: "x",
        tenantId: "t",
        findingId: "f",
        agentId: "a",
        overriddenBy: "u",
        reason: "r",
      }),
    ).rejects.toThrow(/no row/);
  });

  it("listOverridesByAgent clamps the limit", async () => {
    const { c, calls } = client(() => ({ rows: [] }));
    await listOverridesByAgent(c, "agent_1", 9999);
    expect(calls[0]!.params[1]).toBe(500);
  });
});
