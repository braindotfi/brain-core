import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { InMemoryAuditEmitter, isBrainError, newTenantId, newUserId } from "@brain/shared";
import { normalizePlaidArtifact } from "./plaid.js";

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

describe("normalizePlaidArtifact", () => {
  it("validates plaid_tx_v1 and returns no direct Ledger rows after canonical cutover", async () => {
    const { pool, calls } = capturingPool();
    const created = await normalizePlaidArtifact(pool, new InMemoryAuditEmitter(), ctx, {
      rawParsedId: "prs_plaid",
      rawArtifactId: "raw_plaid",
      payload: {
        accounts: [{ account_id: "acc_1", name: "Operating", type: "depository" }],
        transactions: [
          { transaction_id: "tx_1", account_id: "acc_1", amount: 12.34, date: "2026-07-01" },
        ],
      },
    });

    expect(created).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("rejects malformed parser arrays", async () => {
    const { pool } = capturingPool();
    await expect(
      normalizePlaidArtifact(pool, new InMemoryAuditEmitter(), ctx, {
        rawParsedId: "prs_plaid",
        rawArtifactId: "raw_plaid",
        payload: { accounts: "bad" },
      }),
    ).rejects.toSatisfy((err: unknown) => isBrainError(err) && err.code === "ledger_row_invalid");
  });
});
