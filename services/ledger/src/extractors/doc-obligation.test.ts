import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { InMemoryAuditEmitter, isBrainError, newTenantId, newUserId } from "@brain/shared";
import { normalizeDocObligationArtifact, parseDocObligationPayload } from "./doc-obligation.js";

/** Fake pool that captures each query and routes routed rows by substring. */
function capturingPool(routes: Record<string, Array<Record<string, unknown>>> = {}): {
  pool: Pool;
  calls: { text: string; values: unknown[] }[];
} {
  const calls: { text: string; values: unknown[] }[] = [];
  const client = {
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(text.trim())) return { rows: [], rowCount: 0 };
      if (text.startsWith("SELECT set_config")) return { rows: [], rowCount: 0 };
      for (const [pattern, rows] of Object.entries(routes)) {
        if (text.includes(pattern)) return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  return { pool: { connect: async () => client } as unknown as Pool, calls };
}

const ctx = { tenantId: newTenantId(), actor: newUserId() };

const validPayload = {
  counterparty_name: "Acme Utilities",
  direction: "payable",
  type: "bill",
  amount: "120.50",
  currency: "USD",
  due_date: "2026-07-01T00:00:00Z",
};

describe("parseDocObligationPayload", () => {
  it("accepts a well-formed payload and defaults status to upcoming", () => {
    const parsed = parseDocObligationPayload(validPayload);
    expect(parsed.counterparty_name).toBe("Acme Utilities");
    expect(parsed.direction).toBe("payable");
    expect(parsed.type).toBe("bill");
    expect(parsed.amount).toBe("120.50");
    expect(parsed.status).toBe("upcoming");
  });

  it("carries optional minimum_due and recurrence through", () => {
    const parsed = parseDocObligationPayload({
      ...validPayload,
      minimum_due: "25.00",
      recurrence: "FREQ=MONTHLY",
      status: "due",
    });
    expect(parsed.minimum_due).toBe("25.00");
    expect(parsed.recurrence).toBe("FREQ=MONTHLY");
    expect(parsed.status).toBe("due");
  });

  it.each([
    ["missing counterparty_name", { ...validPayload, counterparty_name: undefined }],
    ["bad direction", { ...validPayload, direction: "sideways" }],
    ["bad type", { ...validPayload, type: "mortgage" }],
    ["non-decimal amount", { ...validPayload, amount: "ten dollars" }],
    ["bad currency", { ...validPayload, currency: "usd" }],
    ["bad due_date", { ...validPayload, due_date: "not-a-date" }],
    ["bad status", { ...validPayload, status: "archived" }],
    ["non-decimal minimum_due", { ...validPayload, minimum_due: "lots" }],
  ])("rejects %s with ledger_row_invalid", (_label, input) => {
    try {
      parseDocObligationPayload(input as Record<string, unknown>);
      throw new Error("expected parseDocObligationPayload to throw");
    } catch (err) {
      expect(isBrainError(err)).toBe(true);
      if (isBrainError(err)) expect(err.code).toBe("ledger_row_invalid");
    }
  });
});

// Canonical cutover (RFC 0005): document obligations now flow Raw -> canonical
// -> Ledger projection. normalizeDocObligationArtifact validates and writes
// nothing to the Ledger (stays registered so normalize consumes the row; the
// canonical projector consumes it independently and preserves the low-trust
// agent_contributed provenance so the §6 gate still refuses document-only
// evidence).
describe("normalizeDocObligationArtifact (post-canonical-cutover)", () => {
  it("validates the payload but writes NO Ledger rows", async () => {
    const { pool, calls } = capturingPool();
    const audit = new InMemoryAuditEmitter();

    const created = await normalizeDocObligationArtifact(pool, audit, ctx, {
      rawParsedId: "prs_1",
      rawArtifactId: "raw_1",
      payload: validPayload,
      confidence: 0.8,
    });

    expect(created).toEqual([]);
    expect(calls.some((c) => c.text.startsWith("INSERT"))).toBe(false);
    expect(audit.events).toHaveLength(0);
  });

  it("still throws on a malformed payload (validation preserved)", async () => {
    const { pool } = capturingPool();
    await expect(
      normalizeDocObligationArtifact(pool, new InMemoryAuditEmitter(), ctx, {
        rawParsedId: "prs_x",
        rawArtifactId: "raw_x",
        payload: { ...validPayload, direction: "sideways" },
        confidence: 0.5,
      }),
    ).rejects.toThrow();
  });
});
