import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { InMemoryAuditEmitter, newTenantId, newUserId } from "@brain/shared";
import { normalizePlaidArtifact } from "./plaid.js";

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

describe("normalizePlaidArtifact", () => {
  it("skips malformed records while ingesting the rest of the batch", async () => {
    const { pool, calls } = capturingPool({
      "INSERT INTO ledger_accounts": [{ id: "acct_LEDGER" }],
      "INSERT INTO ledger_transactions": [{ id: "tx_LEDGER" }],
    });

    const created = await normalizePlaidArtifact(pool, new InMemoryAuditEmitter(), ctx, {
      rawParsedId: "prs_plaid",
      rawArtifactId: "raw_plaid",
      payload: {
        accounts: [
          {
            account_id: "acc_1",
            name: "Operating",
            type: "depository",
            subtype: "checking",
            iso_currency_code: "usd",
          },
          { account_id: 42, name: "Bad", type: "depository" },
        ],
        transactions: [
          {
            transaction_id: "tx_1",
            account_id: "acc_1",
            amount: 12.34,
            iso_currency_code: "usd",
            date: "2026-07-01",
            pending: false,
          },
          {
            transaction_id: "tx_bad",
            account_id: "acc_1",
            amount: "not-number",
            iso_currency_code: "usd",
            date: "2026-07-01",
            pending: false,
          },
        ],
      },
    });

    expect(created.map((row) => row.entity)).toEqual(["account", "transaction"]);
    expect(calls.filter((c) => c.text.includes("INSERT INTO ledger_accounts"))).toHaveLength(1);
    expect(calls.filter((c) => c.text.includes("INSERT INTO ledger_transactions"))).toHaveLength(1);
  });
});
