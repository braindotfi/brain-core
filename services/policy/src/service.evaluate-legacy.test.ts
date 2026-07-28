import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  InMemoryAuditEmitter,
  newAgentId,
  newTenantId,
  type ServiceCallContext,
} from "@brain/shared";
import { PolicyService } from "./service.js";
import type { PolicyDocument } from "./dsl.js";

function poolWithActivePolicy(content: PolicyDocument): {
  pool: Pool;
  queries: Array<{ sql: string; values: unknown[] }>;
} {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const row = {
    id: "pol_01TEST0000000000000000000",
    tenant_id: "tnt_01TEST0000000000000000000",
    version: 1,
    content,
    content_hash: Buffer.from("00", "hex"),
    quorum_required: 1,
    state: "active",
    created_by: "usr_01TEST0000000000000000000",
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
  };
  const client = {
    query: vi.fn((sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (
        sql === "BEGIN" ||
        sql === "COMMIT" ||
        sql === "ROLLBACK" ||
        sql.startsWith("SELECT set_config")
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (sql.includes("FROM policies")) {
        return Promise.resolve({ rows: [row] as unknown[], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    }),
    release: vi.fn(),
  };
  return { pool: { connect: vi.fn(() => Promise.resolve(client)) } as unknown as Pool, queries };
}

const ctx: ServiceCallContext = { tenantId: newTenantId(), actor: newAgentId() };

describe("PolicyService.evaluateLegacy", () => {
  it("threads agent confidence, evidence, risk, and id into legacy agent evaluation", async () => {
    const { pool } = poolWithActivePolicy({
      version: 1,
      rules: [
        {
          id: "agent-gate",
          applies_to: ["any"],
          when: {
            "agent.confidence.gte": 0.8,
            "agent.evidence_score.gte": 0.7,
            "agent.risk_level.lte": "medium",
            "agent.id": "agent_payment",
          },
          execute: "auto",
        },
      ],
    });
    const svc = new PolicyService({
      pool,
      audit: new InMemoryAuditEmitter(),
    });

    await expect(
      svc.evaluateLegacy(ctx, {
        kind: "agent_action",
        agent_id: "agent_payment",
        confidence: 0.4,
        evidence_score: 0.9,
        risk_level: "low",
      }),
    ).resolves.toMatchObject({ outcome: "reject" });

    await expect(
      svc.evaluateLegacy(ctx, {
        kind: "agent_action",
        agent_id: "agent_payment",
        confidence: 0.9,
        evidence_score: 0.9,
        risk_level: "low",
      }),
    ).resolves.toMatchObject({ outcome: "allow" });
  });

  it("persists a non-null subject id for legacy agent_action policy decisions", async () => {
    const audit = new InMemoryAuditEmitter();
    const { pool, queries } = poolWithActivePolicy({
      version: 1,
      rules: [{ id: "agent-auto", applies_to: ["agent_action"], when: {}, execute: "auto" }],
    });
    const svc = new PolicyService({ pool, audit });

    await expect(
      svc.evaluateLegacy(ctx, {
        kind: "agent_action",
        agent_id: "treasury",
        balance_id: "bal_123",
      }),
    ).resolves.toMatchObject({ outcome: "allow" });

    const insert = queries.find((q) => q.sql.includes("INSERT INTO policy_decisions"));
    expect(insert?.values[4]).toBe("agent_action");
    expect(insert?.values[5]).toBe("bal_123");
    expect(audit.events[0]?.inputs).toMatchObject({
      subject_type: "agent_action",
      subject_id: "bal_123",
    });
  });
});
