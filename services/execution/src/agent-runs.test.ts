import { describe, expect, it, vi } from "vitest";
import type { TenantScopedClient } from "@brain/shared";
import {
  amountBucket,
  buildEventIdempotencyKey,
  buildProposalDedupKey,
  claimEventIdempotencyKey,
  dayBucket,
  findAgentRun,
  findRoutingDecision,
  insertAgentRun,
  insertEvidenceRef,
  insertReasoningTrace,
  insertRoutingDecision,
  insertRunStep,
  isUniqueViolation,
  listAgentRuns,
  updateAgentRun,
  type InsertAgentRunInput,
} from "./agent-runs.js";

// Substring-routed fake TenantScopedClient (no DB).
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

function runInput(over: Partial<InsertAgentRunInput> = {}): InsertAgentRunInput {
  return {
    id: "run_1",
    tenantId: "tnt_x",
    tenantCategory: "business",
    agentId: "agent_1",
    agentKind: "internal",
    executionMode: "execute",
    status: "executed",
    reason: { why: "ok" },
    shadowMode: false,
    ...over,
  };
}

describe("dayBucket", () => {
  it("is the UTC date (YYYY-MM-DD)", () => {
    expect(dayBucket(new Date("2026-05-23T23:59:59Z"))).toBe("2026-05-23");
    expect(dayBucket(new Date("2026-05-24T00:00:01Z"))).toBe("2026-05-24");
  });
});

describe("buildEventIdempotencyKey", () => {
  const base = {
    tenantId: "tnt_acme",
    eventType: "invoice.overdue",
    objectType: "invoice",
    objectId: "inv_1",
    agentId: "collections",
    action: "draft_followup",
    day: "2026-05-23",
  };

  it("joins the canonical key parts", () => {
    expect(buildEventIdempotencyKey(base)).toBe(
      "tnt_acme:invoice.overdue:invoice:inv_1:collections:draft_followup:2026-05-23",
    );
  });

  it("buckets by day so a later re-fire is a new key", () => {
    const today = buildEventIdempotencyKey(base);
    const tomorrow = buildEventIdempotencyKey({ ...base, day: "2026-05-24" });
    expect(today).not.toBe(tomorrow);
  });
});

describe("amountBucket", () => {
  it("rounds to the nearest whole unit so near-duplicates collide", () => {
    expect(amountBucket("100.40")).toBe("100");
    expect(amountBucket("100.50")).toBe("101");
    expect(amountBucket("not-a-number")).toBe("not-a-number");
  });
});

describe("buildProposalDedupKey", () => {
  it("prefers obligation, then invoice, then counterparty+amount+day", () => {
    expect(
      buildProposalDedupKey({ tenantId: "tnt_a", agentId: "payment", obligationId: "obl_1" }),
    ).toBe("tnt_a:payment:obl:obl_1");
    expect(
      buildProposalDedupKey({ tenantId: "tnt_a", agentId: "payment", invoiceId: "inv_1" }),
    ).toBe("tnt_a:payment:inv:inv_1");
    expect(
      buildProposalDedupKey({
        tenantId: "tnt_a",
        agentId: "payment",
        counterpartyId: "cp_1",
        amount: "500.20",
        currency: "USD",
        day: "2026-05-23",
      }),
    ).toBe("tnt_a:payment:cpa:cp_1:USD:500:2026-05-23");
  });

  it("returns null when there is no stable discriminator", () => {
    expect(buildProposalDedupKey({ tenantId: "tnt_a", agentId: "payment" })).toBeNull();
  });
});

describe("isUniqueViolation", () => {
  it("matches Postgres SQLSTATE 23505", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
    expect(isUniqueViolation({ code: "23503" })).toBe(false);
    expect(isUniqueViolation(new Error("x"))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});

describe("agent_runs repository", () => {
  it("insertAgentRun returns the row and JSON-encodes reason", async () => {
    const { c, calls } = client(() => ({ rows: [{ id: "run_1" }] }));
    const out = await insertAgentRun(c, runInput());
    expect(out.id).toBe("run_1");
    expect(calls[0]!.params[21]).toBe(JSON.stringify({ why: "ok" })); // reason
  });

  it("insertAgentRun throws when no row is returned", async () => {
    const { c } = client(() => ({ rows: [] }));
    await expect(insertAgentRun(c, runInput())).rejects.toThrow(/no row/);
  });

  it("findAgentRun returns the row or null", async () => {
    expect((await findAgentRun(client(() => ({ rows: [{ id: "run_1" }] })).c, "run_1"))?.id).toBe(
      "run_1",
    );
    expect(await findAgentRun(client(() => ({ rows: [] })).c, "nope")).toBeNull();
  });

  it("updateAgentRun builds the SET clause from the patch incl. completed_at", async () => {
    const { c, calls } = client(() => ({ rows: [{ id: "run_1" }] }));
    await updateAgentRun(c, "run_1", { status: "failed", proposalId: "prop_1", completed: true });
    const sql = calls[0]!.sql;
    expect(sql).toContain("status =");
    expect(sql).toContain("proposal_id =");
    expect(sql).toContain("completed_at = now()");
    expect(calls[0]!.params).toEqual(["run_1", "failed", "prop_1"]);
  });

  it("updateAgentRun with an empty patch only touches updated_at; returns null when absent", async () => {
    const { c, calls } = client(() => ({ rows: [] }));
    expect(await updateAgentRun(c, "run_1", {})).toBeNull();
    expect(calls[0]!.sql).toContain("updated_at = now()");
    expect(calls[0]!.params).toEqual(["run_1"]);
  });

  it("listAgentRuns applies filters and clamps the limit", async () => {
    const { c, calls } = client(() => ({ rows: [{ id: "run_1" }] }));
    await listAgentRuns(c, { agentId: "agent_1", status: "executed", category: "business", limit: 9999 });
    expect(calls[0]!.sql).toContain("WHERE");
    expect(calls[0]!.sql).toContain("LIMIT 500");
    expect(calls[0]!.params).toEqual(["agent_1", "executed", "business"]);

    const { c: c2, calls: calls2 } = client(() => ({ rows: [] }));
    await listAgentRuns(c2, {});
    expect(calls2[0]!.sql).not.toContain("WHERE");
    expect(calls2[0]!.sql).toContain("LIMIT 100");
  });

  it("insertRoutingDecision returns the row / throws when absent", async () => {
    const ok = client(() => ({ rows: [{ id: "rd_1" }] }));
    expect(
      (
        await insertRoutingDecision(ok.c, {
          id: "rd_1",
          tenantId: "tnt_x",
          tenantCategory: "business",
          policyStatus: "routed",
          reason: { r: 1 },
        })
      ).id,
    ).toBe("rd_1");
    const empty = client(() => ({ rows: [] }));
    await expect(
      insertRoutingDecision(empty.c, {
        id: "rd_2",
        tenantId: "tnt_x",
        tenantCategory: "business",
        policyStatus: "no_match",
        reason: {},
      }),
    ).rejects.toThrow(/no row/);
  });

  it("findRoutingDecision returns the row or null", async () => {
    expect(
      (await findRoutingDecision(client(() => ({ rows: [{ id: "rd_1" }] })).c, "rd_1"))?.id,
    ).toBe("rd_1");
    expect(await findRoutingDecision(client(() => ({ rows: [] })).c, "x")).toBeNull();
  });

  it("insertRunStep encodes detail (default {})", async () => {
    const { c, calls } = client(() => ({ rows: [] }));
    await insertRunStep(c, {
      id: "step_1",
      tenantId: "tnt_x",
      runId: "run_1",
      stepIndex: 0,
      kind: "gather",
      status: "ok",
    });
    expect(calls[0]!.params[6]).toBe("{}");
  });

  it("insertEvidenceRef applies defaults (stale=false)", async () => {
    const { c, calls } = client(() => ({ rows: [] }));
    await insertEvidenceRef(c, {
      id: "ev_1",
      tenantId: "tnt_x",
      runId: "run_1",
      kind: "invoice",
      ref: "inv_1",
    });
    expect(calls[0]!.params[13]).toBe(false); // stale default
    expect(calls[0]!.params[5]).toBeNull(); // source_system default
  });

  it("insertReasoningTrace inserts a row with the redacted view", async () => {
    const { c, calls } = client(() => ({ rows: [] }));
    await insertReasoningTrace(c, {
      id: "rt_1",
      tenantId: "tnt_x",
      agentId: "agent_1",
      runId: "run_1",
      modelId: "claude",
      modelVersion: "4.7",
      promptTemplateHash: Buffer.alloc(32),
      toolManifestHash: Buffer.alloc(32),
      retrievedEvidenceIds: ["ev_1"],
      toolCallsRedacted: {},
      outputStructured: { ok: true },
      redactionPolicyId: "rp_1",
      toolCallsRawHash: Buffer.alloc(32),
      outputRawHash: Buffer.alloc(32),
      llmTokensIn: 10,
      llmTokensOut: 5,
      llmCostUsd: "0.01",
    });
    expect(calls[0]!.sql).toContain("INSERT INTO agent_reasoning_traces");
    expect(calls[0]!.params[10]).toBe(JSON.stringify({ ok: true })); // output_structured
  });

  it("claimEventIdempotencyKey: claimed on first insert", async () => {
    const { c } = client((sql) =>
      sql.includes("INSERT INTO agent_idempotency_keys") ? { rows: [{ run_id: "run_1" }] } : { rows: [] },
    );
    expect(await claimEventIdempotencyKey(c, { id: "k1", tenantId: "tnt_x", key: "K", runId: "run_1" })).toEqual({
      claimed: true,
      runId: "run_1",
    });
  });

  it("claimEventIdempotencyKey: not claimed on conflict, returns existing run_id", async () => {
    const { c } = client((sql) =>
      sql.startsWith("INSERT")
        ? { rows: [] } // ON CONFLICT DO NOTHING
        : { rows: [{ run_id: "run_existing" }] },
    );
    expect(await claimEventIdempotencyKey(c, { id: "k1", tenantId: "tnt_x", key: "K", runId: "run_new" })).toEqual({
      claimed: false,
      runId: "run_existing",
    });
  });

  it("claimEventIdempotencyKey: null run_id when conflict row is gone", async () => {
    const { c } = client(() => ({ rows: [] }));
    expect(await claimEventIdempotencyKey(c, { id: "k1", tenantId: "tnt_x", key: "K", runId: "run_new" })).toEqual({
      claimed: false,
      runId: null,
    });
  });
});
