/**
 * H-25 run-loaders test (no Postgres). Exercises the SQL-routing + row mapping
 * of makeRunLoaders against a fake pool. Live joins/RLS are a pg integration
 * test, blocked here (see run-loaders.ts SANDBOX NOTE).
 */

import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { newTenantId, type Proof, type ServiceCallContext } from "@brain/shared";
import { makeRunLoaders } from "./run-loaders.js";

const TENANT = newTenantId();
const ctx: ServiceCallContext = { tenantId: TENANT, actor: "user_1", requestId: "req_1" };

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

const fakeProof = vi.fn(async (_t: string, actionId: string): Promise<Proof | null> => {
  return { action_id: actionId, outcome: "executed" } as unknown as Proof;
});

const RUN_REFS = {
  payment_intent_id: "pi_1",
  agent_id: "agent_pay",
  routing_decision_id: "agrd_1",
};

describe("makeRunLoaders.evidence", () => {
  it("maps agent_evidence_refs for a visible run", async () => {
    const pool = makeFakePool((sql) => {
      if (sql.includes("FROM agent_runs")) return [RUN_REFS];
      if (sql.includes("FROM agent_evidence_refs")) {
        return [
          {
            id: "agev_1",
            kind: "invoice",
            ref: "inv_1",
            source_system: "ledger",
            object_type: "invoice",
            object_id: "inv_1",
            confidence: 0.9,
            hash: Buffer.from("ab", "hex"),
            stale: false,
            required: true,
          },
        ];
      }
      return [];
    });
    const loaders = makeRunLoaders(pool, fakeProof);
    const evidence = await loaders.evidence(ctx, "agnr_1");
    expect(evidence).not.toBeNull();
    expect(evidence?.[0]).toMatchObject({ id: "agev_1", kind: "invoice", hash: "ab" });
  });

  it("returns null when the run is not visible (tenant isolation)", async () => {
    const pool = makeFakePool(() => []); // findRunRefs → no row
    const loaders = makeRunLoaders(pool, fakeProof);
    expect(await loaders.evidence(ctx, "agnr_other")).toBeNull();
  });
});

describe("makeRunLoaders.gateTrace", () => {
  it("pulls gate_checks from the execute.before audit event", async () => {
    const pool = makeFakePool((sql) => {
      if (sql.includes("FROM agent_runs")) return [RUN_REFS];
      if (sql.includes("FROM audit_events")) {
        return [
          {
            outputs: { gate_checks: [{ index: 1, name: "agent_identity_verified", passed: true }] },
          },
        ];
      }
      return [];
    });
    const loaders = makeRunLoaders(pool, fakeProof);
    const trace = await loaders.gateTrace(ctx, "agnr_1");
    expect(trace?.payment_intent_id).toBe("pi_1");
    expect(trace?.gate_checks[0]?.name).toBe("agent_identity_verified");
  });

  it("returns empty gate_checks when the run has no PaymentIntent", async () => {
    const pool = makeFakePool((sql) =>
      sql.includes("FROM agent_runs") ? [{ ...RUN_REFS, payment_intent_id: null }] : [],
    );
    const loaders = makeRunLoaders(pool, fakeProof);
    const trace = await loaders.gateTrace(ctx, "agnr_1");
    expect(trace).toEqual({ run_id: "agnr_1", payment_intent_id: null, gate_checks: [] });
  });
});

describe("makeRunLoaders.proof", () => {
  it("proxies the proof builder for the run's PaymentIntent", async () => {
    const pool = makeFakePool((sql) => (sql.includes("FROM agent_runs") ? [RUN_REFS] : []));
    const loaders = makeRunLoaders(pool, fakeProof);
    const proof = (await loaders.proof(ctx, "agnr_1")) as Proof | null;
    expect(proof?.action_id).toBe("pi_1");
    expect(fakeProof).toHaveBeenCalledWith(TENANT, "pi_1");
  });

  it("returns null when the run produced no action", async () => {
    const pool = makeFakePool((sql) =>
      sql.includes("FROM agent_runs") ? [{ ...RUN_REFS, payment_intent_id: null }] : [],
    );
    const loaders = makeRunLoaders(pool, fakeProof);
    expect(await loaders.proof(ctx, "agnr_1")).toBeNull();
  });
});

describe("makeRunLoaders.behaviorHash + evidenceCount", () => {
  it("returns the agent scope hash as hex", async () => {
    const pool = makeFakePool((sql) => {
      if (sql.includes("FROM agent_runs")) return [RUN_REFS];
      if (sql.includes("FROM agents")) return [{ scope_hash: Buffer.from("beef", "hex") }];
      return [];
    });
    const loaders = makeRunLoaders(pool, fakeProof);
    expect(await loaders.behaviorHash(ctx, "agnr_1")).toBe("beef");
  });

  it("counts evidence refs", async () => {
    const pool = makeFakePool((sql) => (sql.includes("count(*)") ? [{ n: "3" }] : []));
    const loaders = makeRunLoaders(pool, fakeProof);
    expect(await loaders.evidenceCount(ctx, "agnr_1")).toBe(3);
  });
});
