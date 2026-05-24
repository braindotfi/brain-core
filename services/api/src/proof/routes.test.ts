/**
 * Proof builder integration-ish test (no Postgres).
 *
 * Exercises poolProofBuilder end to end — fetchProofSources → assembleProof →
 * renderProofExplanation, including real Merkle proof construction — against a
 * fake pool that routes each query by SQL substring. Covers the "every field
 * populated for an executed PaymentIntent" acceptance + the tenant-isolation
 * 404 path (PI not visible => null). The live joins/RLS are a pg integration
 * test, blocked here (see fetchProofSources SANDBOX NOTE).
 */

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { newTenantId } from "@brain/shared";
import { poolProofBuilder } from "./routes.js";

const EVENT_HASH = createHash("sha256").update("before").digest(); // 32-byte leaf
const TENANT = newTenantId();

function makeFakePool(rowsFor: (sql: string) => unknown[]): Pool {
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
      const rows = rowsFor(sql);
      return Promise.resolve({ rows, rowCount: rows.length });
    }),
    release: vi.fn(),
  };
  return { connect: vi.fn(() => Promise.resolve(client)) } as unknown as Pool;
}

const OPTS = { anchorContractAddress: "0xanchor", chain: "base-sepolia" as const };

function rowsForExecuted(sql: string): unknown[] {
  if (sql.includes("FROM ledger_payment_intents")) {
    return [
      {
        id: "pi_ACTION",
        created_by_agent_id: "agent_1",
        status: "executed",
        policy_decision_id: "pd_1",
        evidence_ids: ["prs_1"],
        execution_receipt_ids: ["exec_1"],
      },
    ];
  }
  if (sql.includes("FROM policy_decisions")) {
    return [
      {
        policy_id: "pol_1",
        policy_version: 3,
        matched_rule_id: "allow-small",
        ledger_snapshot_hash: "snap123",
        outcome: "allow",
      },
    ];
  }
  if (sql.includes("FROM policies")) return [{ content_hash: "deadbeef" }];
  if (sql.includes("FROM audit_events") && sql.includes("inputs->>'payment_intent_id'")) {
    return [
      {
        id: "evt_before",
        action: "payment_intent.execute.before",
        layer: "agent",
        outputs: {
          gate_passed: true,
          gate_checks: [{ index: 1, name: "agent_identity_verified", passed: true }],
        },
        event_hash: EVENT_HASH,
        prev_event_hash: null,
        created_at: new Date("2026-01-01T00:00:00Z"),
      },
    ];
  }
  if (sql.includes("FROM raw_parsed")) {
    return [
      { id: "prs_1", sha256: "ff", source_type: "plaid", kind: "invoice", trust_level: "high" },
    ];
  }
  if (sql.includes("FROM executions")) return [{ rail_receipt: { rail: "ach", ach_trace: "t" } }];
  if (sql.includes("FROM audit_anchors")) {
    return [
      {
        period_start: new Date("2025-12-31T00:00:00Z"),
        period_end: new Date("2026-01-02T00:00:00Z"),
        onchain_tx_hash: Buffer.from("aa".repeat(32), "hex"),
        onchain_block_number: 100,
      },
    ];
  }
  if (sql.includes("FROM audit_events") && sql.includes("created_at >=")) {
    return [{ id: "evt_before", event_hash: EVENT_HASH }];
  }
  if (sql.includes("FROM agents")) return [{ scope_hash: Buffer.from("bb".repeat(32), "hex") }];
  if (sql.includes("FROM agent_runs")) return [{ shadow_mode: false }];
  return [];
}

describe("poolProofBuilder", () => {
  it("assembles a fully-populated Proof for an executed PaymentIntent", async () => {
    const build = poolProofBuilder(makeFakePool(rowsForExecuted), OPTS);
    const proof = await build(TENANT, "pi_ACTION");
    expect(proof).not.toBeNull();
    if (proof === null) return;

    expect(proof.action_id).toBe("pi_ACTION");
    expect(proof.tenant_id).toBe(TENANT);
    expect(proof.agent_id).toBe("agent_1");
    expect(proof.outcome).toBe("executed");
    expect(proof.policy_version).toBe("3");
    expect(proof.policy_hash).toBe("deadbeef");
    expect(proof.matched_rule_id).toBe("allow-small");
    expect(proof.ledger_snapshot_hash).toBe("snap123");
    expect(proof.gate_checks).toHaveLength(1);
    expect(proof.evidence[0]?.raw_parsed_id).toBe("prs_1");
    expect(proof.audit_events[0]?.id).toBe("evt_before");
    expect(proof.behavior_hash).toBe("bb".repeat(32));
    // Single-leaf window: a real (domain-separated) Merkle root, empty path.
    expect(proof.merkle_root).toMatch(/^[0-9a-f]{64}$/);
    expect(proof.merkle_proof).toEqual([]);
    expect(proof.chain_anchor).toEqual({
      tx_hash: "aa".repeat(32),
      block_number: 100,
      contract_address: "0xanchor",
      chain: "base-sepolia",
    });
    expect(proof.rail_receipt).toEqual({ rail: "ach", ach_trace: "t" });
    expect(proof.human_explanation).toContain("agent_1");
    expect(proof.human_explanation).toContain("executed");
  });

  it("returns null when the action is not visible to the tenant (=> 404)", async () => {
    // RLS hides the row → the PI query returns nothing.
    const build = poolProofBuilder(
      makeFakePool((sql) => (sql.includes("FROM ledger_payment_intents") ? [] : [])),
      OPTS,
    );
    expect(await build(newTenantId(), "pi_ACTION")).toBeNull();
  });

  it("shadow run: outcome shadow_completed, rail_receipt null, anchor still present", async () => {
    const build = poolProofBuilder(
      makeFakePool((sql) =>
        sql.includes("FROM agent_runs") ? [{ shadow_mode: true }] : rowsForExecuted(sql),
      ),
      OPTS,
    );
    const proof = await build(TENANT, "pi_ACTION");
    expect(proof?.outcome).toBe("shadow_completed");
    expect(proof?.rail_receipt).toBeNull();
    expect(proof?.chain_anchor).not.toBeNull();
  });
});
