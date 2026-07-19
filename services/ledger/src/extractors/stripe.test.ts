import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { InMemoryAuditEmitter, isBrainError, newTenantId, newUserId } from "@brain/shared";
import { centsToDecimal, normalizeStripeArtifact } from "./stripe.js";
import { extractorForParser, registeredParsers } from "./registry.js";

function capturingPool(): { pool: Pool; calls: { text: string; values: unknown[] }[] } {
  const calls: { text: string; values: unknown[] }[] = [];
  const client = {
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  return { pool: { connect: async () => client } as unknown as Pool, calls };
}

const ctx = { tenantId: newTenantId(), actor: newUserId() };

function input(objectType: string, objects: unknown[], over: Record<string, unknown> = {}) {
  return {
    rawParsedId: "prs_s1",
    rawArtifactId: "raw_s1",
    payload: {
      object_type: objectType,
      stripe_account_id: "acct_S1",
      objects,
      ...over,
    },
    confidence: null,
  };
}

describe("centsToDecimal", () => {
  it("converts integer minor units exactly", () => {
    expect(centsToDecimal(125000)).toBe("1250.00");
    expect(centsToDecimal(-1250)).toBe("12.50");
    expect(centsToDecimal(7)).toBe("0.07");
    expect(centsToDecimal(0)).toBe("0.00");
  });

  it("rejects non-integer amounts", () => {
    expect(() => centsToDecimal(12.5)).toThrow(/integer minor units/);
  });
});

describe("normalizeStripeArtifact", () => {
  it("is registered in the parser registry", () => {
    expect(registeredParsers()).toContain("stripe_v1");
    expect(extractorForParser("stripe_v1")).toBeDefined();
  });

  it("validates stripe_v1 and returns no direct Ledger rows after canonical cutover", async () => {
    const { pool, calls } = capturingPool();
    const created = await normalizeStripeArtifact(
      pool,
      new InMemoryAuditEmitter(),
      ctx,
      input("charge", [{ id: "ch_1", amount: 125000, currency: "usd" }]),
    );

    expect(created).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("rejects malformed parser payloads", async () => {
    const { pool } = capturingPool();
    await expect(
      normalizeStripeArtifact(
        pool,
        new InMemoryAuditEmitter(),
        ctx,
        input("charge", [], { objects: "bad" }),
      ),
    ).rejects.toSatisfy((err: unknown) => isBrainError(err) && err.code === "ledger_row_invalid");
  });
});
