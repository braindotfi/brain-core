import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { InMemoryAuditEmitter, isBrainError, newTenantId, newUserId } from "@brain/shared";
import { normalizeFinchArtifact } from "./finch.js";
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

function input(objectType: string, objects: unknown[]) {
  return {
    rawParsedId: "prs_f1",
    rawArtifactId: "raw_f1",
    payload: { object_type: objectType, objects },
    confidence: null,
  };
}

describe("normalizeFinchArtifact", () => {
  it("is registered under the spec parser id", () => {
    expect(registeredParsers()).toContain("finch_payroll_v1");
    expect(extractorForParser("finch_payroll_v1")).toBeDefined();
  });

  it("validates finch_payroll_v1 and returns no direct Ledger rows after canonical cutover", async () => {
    const { pool, calls } = capturingPool();
    const created = await normalizeFinchArtifact(
      pool,
      new InMemoryAuditEmitter(),
      ctx,
      input("pay_run", [{ id: "pay_1", pay_date: "2026-07-01" }]),
    );

    expect(created).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("rejects malformed parser payloads", async () => {
    const { pool } = capturingPool();
    await expect(
      normalizeFinchArtifact(pool, new InMemoryAuditEmitter(), ctx, {
        ...input("pay_run", []),
        payload: { object_type: "pay_run", objects: "bad" },
      }),
    ).rejects.toSatisfy((err: unknown) => isBrainError(err) && err.code === "ledger_row_invalid");
  });
});
