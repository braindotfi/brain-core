import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  InMemoryAuditEmitter,
  newAgentId,
  newTenantId,
  type ServiceCallContext,
} from "@brain/shared";
import { PolicyService } from "./service.js";
import { contentHashHex, type PolicyDocument } from "./dsl.js";

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
    content_hash: Buffer.from(contentHashHex(content), "hex"),
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
  it.each([
    ["collections", "collections"],
    ["fraud_anomaly", "flag_transaction"],
    ["vendor_risk", "block_payment"],
  ])("routes unmatched high-risk %s proposals to confirmation", async (agentId, actionType) => {
    const { pool, queries } = poolWithActivePolicy({
      version: 1,
      rules: [
        {
          id: "default-agent-action-requires-review",
          applies_to: ["agent_action"],
          when: { "agent.confidence.gte": 0.6 },
          execute: "confirm",
          require: "single_signer",
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
        type: actionType,
        agent_id: agentId,
        agent_role: agentId,
        confidence: 0.4,
        evidence_score: 1,
        risk_level: "high",
      }),
    ).resolves.toMatchObject({
      outcome: "confirm",
      matched_rule_id: null,
      required_approvers: ["signer"],
    });

    const insert = queries.find((q) => q.sql.includes("INSERT INTO policy_decisions"));
    expect(insert?.values[6]).toBe("confirm");
    expect(insert?.values[7]).toBeNull();
    expect(insert?.values[8]).toEqual(["signer"]);
  });

  it("keeps low-stakes unmatched proposal types rejected", async () => {
    const { pool } = poolWithActivePolicy({
      version: 1,
      rules: [
        {
          id: "default-agent-action-requires-review",
          applies_to: ["agent_action"],
          when: { "agent.confidence.gte": 0.6 },
          execute: "confirm",
          require: "single_signer",
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
        type: "cash_forecast",
        agent_id: "cash_forecast",
        agent_role: "cash_forecast",
        confidence: 0.4,
        evidence_score: 1,
        risk_level: "low",
      }),
    ).resolves.toMatchObject({
      outcome: "reject",
      matched_rule_id: null,
      required_approvers: [],
    });
  });

  it("keeps payment proposals fail-closed when unmatched", async () => {
    const { pool } = poolWithActivePolicy({
      version: 1,
      rules: [
        {
          id: "default-agent-action-requires-review",
          applies_to: ["agent_action"],
          when: { "agent.confidence.gte": 0.6 },
          execute: "confirm",
          require: "single_signer",
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
        type: "payment",
        agent_id: "payment",
        agent_role: "payment",
        confidence: 0.4,
        evidence_score: 1,
        risk_level: "high",
      }),
    ).resolves.toMatchObject({
      outcome: "reject",
      matched_rule_id: null,
      required_approvers: [],
    });
  });

  it("leaves high-risk proposals that match a real rule unchanged", async () => {
    const { pool } = poolWithActivePolicy({
      version: 1,
      rules: [
        {
          id: "review-low-confidence-agent-actions",
          applies_to: ["agent_action"],
          when: { "agent.confidence.gte": 0.3 },
          execute: "confirm",
          require: "single_signer",
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
        type: "flag_transaction",
        agent_id: "fraud_anomaly",
        agent_role: "fraud_anomaly",
        confidence: 0.4,
        evidence_score: 1,
        risk_level: "high",
      }),
    ).resolves.toMatchObject({
      outcome: "confirm",
      matched_rule_id: "review-low-confidence-agent-actions",
      required_approvers: ["signer"],
    });
  });

  it("leaves collections proposals that match a real rule unchanged", async () => {
    const { pool } = poolWithActivePolicy({
      version: 1,
      rules: [
        {
          id: "review-low-confidence-collections",
          applies_to: ["agent_action"],
          when: { "agent.confidence.gte": 0.3 },
          execute: "confirm",
          require: "single_signer",
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
        type: "collections",
        agent_id: "collections",
        agent_role: "collections",
        confidence: 0.4,
        evidence_score: 1,
        risk_level: "medium",
      }),
    ).resolves.toMatchObject({
      outcome: "confirm",
      matched_rule_id: "review-low-confidence-collections",
      required_approvers: ["signer"],
    });
  });

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

  it("captures allowlisted source references for a stable subject", async () => {
    const audit = new InMemoryAuditEmitter();
    const { pool, queries } = poolWithActivePolicy({
      version: 1,
      rules: [{ id: "agent-auto", applies_to: ["agent_action"], when: {}, execute: "auto" }],
    });
    const svc = new PolicyService({ pool, audit });

    await svc.evaluateLegacy(ctx, {
      kind: "agent_action",
      proposal_id: "prop_1",
      source_action_id: "act_1",
      payment_intent_id: "pi_1",
      subject_refs: [
        { kind: "counterparty", ref: "cp_1" },
        { kind: "note", ref: "never-store-freeform-metadata" },
      ],
      invoice_id: "inv_1",
      amount: { currency: "USD", value: "125.00" },
    });

    const insert = queries.find((q) => q.sql.includes("INSERT INTO policy_decisions"));
    const sourceRefs = JSON.parse(String(insert?.values[11]));
    expect(sourceRefs).toEqual({
      source_action_id: "act_1",
      source_proposal_id: "prop_1",
      payment_intent_id: "pi_1",
      source_entity_refs: [
        { kind: "counterparty", ref: "cp_1" },
        { kind: "invoice", ref: "inv_1" },
        { kind: "payment_intent", ref: "pi_1" },
      ],
      amount: { currency: "USD", value: "125.00" },
    });
    expect(audit.events[0]?.inputs).toMatchObject({ source_refs: sourceRefs });
  });

  it("keeps hash fallback subjects while preserving available partial source references", async () => {
    const { pool, queries } = poolWithActivePolicy({
      version: 1,
      rules: [{ id: "agent-auto", applies_to: ["agent_action"], when: {}, execute: "auto" }],
    });
    const svc = new PolicyService({ pool, audit: new InMemoryAuditEmitter() });

    await svc.evaluateLegacy(ctx, {
      kind: "agent_action",
      payment_intent_id: "pi_1",
      source_entity_refs: [{ kind: "counterparty", ref: "cp_1" }],
    });

    const insert = queries.find((q) => q.sql.includes("INSERT INTO policy_decisions"));
    expect(insert?.values[5]).toMatch(/^agent_action_/);
    expect(JSON.parse(String(insert?.values[11]))).toEqual({
      payment_intent_id: "pi_1",
      source_entity_refs: [
        { kind: "counterparty", ref: "cp_1" },
        { kind: "payment_intent", ref: "pi_1" },
      ],
    });
  });
});
