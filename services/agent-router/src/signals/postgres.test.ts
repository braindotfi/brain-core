/**
 * Postgres signals provider — unit tests against a fake pool.
 *
 * The provider's mixing math is the contract: which components compose how
 * into a single reputation. The DB layout is exercised through a fake pool
 * that returns canned aggregate rows.
 */

import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { newTenantId } from "@brain/shared";
import { PostgresSignalsProvider } from "./postgres.js";

const TNT_A = newTenantId();
const TNT_B = newTenantId();

type AggregateRow = {
  total: string;
  executed: string;
  rejected: string;
  state: string | null;
};

function fakePool(row: AggregateRow): Pool {
  const client = {
    query: vi.fn((sql: string) => {
      if (sql.startsWith("BEGIN") || sql.startsWith("COMMIT") || sql.startsWith("ROLLBACK")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (sql.startsWith("SELECT set_config")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      return Promise.resolve({ rows: [row], rowCount: 1 });
    }),
    release: vi.fn(),
  };
  return {
    connect: vi.fn(() => Promise.resolve(client)),
  } as unknown as Pool;
}

// Weights asserted by the documented contract: success 0.40, rejection 0.25,
// onchain 0.15, state 0.15, dispute 0.05.
const EPSILON = 1e-9;

describe("PostgresSignalsProvider — mixing math", () => {
  it("a never-used agent gets the neutral fallback (0.5 rates)", async () => {
    // total < MIN_SAMPLE (5) ⇒ rates fall back to 0.5; state is active ⇒ 0
    // penalty; no onchain reader ⇒ 0.5. Expected reputation =
    //   0.40*0.5 + 0.25*(1-0.5) + 0.15*0.5 + 0.15*(1-0) + 0.05*(1-0)
    //   = 0.20 + 0.125 + 0.075 + 0.15 + 0.05 = 0.6
    const pool = fakePool({ total: "0", executed: "0", rejected: "0", state: "active" });
    const p = new PostgresSignalsProvider({ pool });
    const s = await p.load("agent_x", TNT_A);
    expect(s.reputation).toBeCloseTo(0.6, 6);
    expect(s.components?.successRate).toBe(0.5);
    expect(s.components?.policyRejectionRate).toBe(0.5);
    expect(s.components?.agentStatePenalty).toBe(0);
    expect(s.components?.onchainReputation).toBe(0.5);
    expect(s.components?.sampleSize).toBe(0);
  });

  it("a flawless agent with enough sample size pegs near 1.0", async () => {
    // 50 PIs, all executed, zero rejections, active state, on-chain 1.0
    //   0.40*1 + 0.25*1 + 0.15*1 + 0.15*1 + 0.05*1 = 1.0
    const pool = fakePool({ total: "50", executed: "50", rejected: "0", state: "active" });
    const p = new PostgresSignalsProvider({
      pool,
      onchain: { getReputation: async () => 1 },
    });
    const s = await p.load("agent_perfect", TNT_A);
    expect(s.reputation).toBeCloseTo(1, 6);
    expect(s.components?.successRate).toBe(1);
    expect(s.components?.policyRejectionRate).toBe(0);
    expect(s.components?.onchainReputation).toBe(1);
    expect(s.components?.sampleSize).toBe(50);
  });

  it("a revoked agent has its state penalty drive reputation by 0.15", async () => {
    // total=20, executed=20, rejected=0, state=revoked, no onchain
    //   0.40*1 + 0.25*(1-0) + 0.15*0.5 + 0.15*(1-1) + 0.05*1 = 0.775
    const pool = fakePool({ total: "20", executed: "20", rejected: "0", state: "revoked" });
    const p = new PostgresSignalsProvider({ pool });
    const s = await p.load("agent_bad", TNT_A);
    expect(s.reputation).toBeCloseTo(0.775, 6);
    expect(s.components?.agentStatePenalty).toBe(1);
  });

  it("high policy rejection rate drops reputation as expected", async () => {
    // total=10, executed=4, rejected=6, state=active, onchain 0.5
    //   0.40*0.4 + 0.25*(1-0.6) + 0.15*0.5 + 0.15*1 + 0.05*1
    //   = 0.16 + 0.10 + 0.075 + 0.15 + 0.05 = 0.535
    const pool = fakePool({ total: "10", executed: "4", rejected: "6", state: "active" });
    const p = new PostgresSignalsProvider({ pool });
    const s = await p.load("agent_x", TNT_A);
    expect(s.reputation).toBeCloseTo(0.535, 6);
    expect(s.components?.policyRejectionRate).toBeCloseTo(0.6, EPSILON);
  });

  it("cost defaults to 0 and tracks an injected per-agent map", async () => {
    const pool = fakePool({ total: "0", executed: "0", rejected: "0", state: "active" });
    const p = new PostgresSignalsProvider({
      pool,
      cost: new Map([["agent_pricey", 0.8]]),
    });
    const s1 = await p.load("agent_pricey", TNT_A);
    const s2 = await p.load("agent_free", TNT_A);
    expect(s1.cost).toBe(0.8);
    expect(s2.cost).toBe(0);
  });

  it("on-chain read failure does not break the provider (falls back to 0.5)", async () => {
    const pool = fakePool({ total: "20", executed: "20", rejected: "0", state: "active" });
    const p = new PostgresSignalsProvider({
      pool,
      onchain: {
        getReputation: async () => {
          throw new Error("rpc down");
        },
      },
    });
    const s = await p.load("agent_x", TNT_A);
    expect(s.components?.onchainReputation).toBe(0.5);
  });

  it("on-chain null return falls back to 0.5 without erroring", async () => {
    const pool = fakePool({ total: "0", executed: "0", rejected: "0", state: "active" });
    const p = new PostgresSignalsProvider({
      pool,
      onchain: { getReputation: async () => null },
    });
    const s = await p.load("agent_x", TNT_A);
    expect(s.components?.onchainReputation).toBe(0.5);
  });
});

describe("PostgresSignalsProvider — caching", () => {
  it("returns the cached value on the second read within the TTL", async () => {
    const pool = fakePool({ total: "10", executed: "8", rejected: "1", state: "active" });
    const p = new PostgresSignalsProvider({ pool, cacheTtlMs: 60_000 });
    const s1 = await p.load("agent_x", TNT_A);
    const s2 = await p.load("agent_x", TNT_A);
    expect(s2).toBe(s1);
    // The pool's connect() was called once for the first DB read; the second
    // call was a cache hit, no DB traffic.
    expect(vi.mocked(pool.connect)).toHaveBeenCalledTimes(1);
  });

  it("clearCache(agentKey, tenantId) drops only the (agent, tenant) entry", async () => {
    const pool = fakePool({ total: "10", executed: "5", rejected: "0", state: "active" });
    const p = new PostgresSignalsProvider({ pool, cacheTtlMs: 60_000 });
    await p.load("agent_x", TNT_A);
    await p.load("agent_x", TNT_B);
    p.clearCache("agent_x", TNT_A);
    await p.load("agent_x", TNT_A); // miss — re-reads
    await p.load("agent_x", TNT_B); // still cached
    expect(vi.mocked(pool.connect)).toHaveBeenCalledTimes(3);
  });

  it("clearCache(agentKey) drops every tenant entry for that agent", async () => {
    const pool = fakePool({ total: "10", executed: "5", rejected: "0", state: "active" });
    const p = new PostgresSignalsProvider({ pool, cacheTtlMs: 60_000 });
    await p.load("agent_x", TNT_A);
    await p.load("agent_x", TNT_B);
    p.clearCache("agent_x");
    await p.load("agent_x", TNT_A);
    await p.load("agent_x", TNT_B);
    expect(vi.mocked(pool.connect)).toHaveBeenCalledTimes(4);
  });

  it("clearCache() with no args wipes everything", async () => {
    const pool = fakePool({ total: "10", executed: "5", rejected: "0", state: "active" });
    const p = new PostgresSignalsProvider({ pool, cacheTtlMs: 60_000 });
    await p.load("agent_x", TNT_A);
    await p.load("agent_y", TNT_A);
    p.clearCache();
    await p.load("agent_x", TNT_A);
    await p.load("agent_y", TNT_A);
    expect(vi.mocked(pool.connect)).toHaveBeenCalledTimes(4);
  });
});
