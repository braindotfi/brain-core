import { describe, expect, it, vi } from "vitest";
import type { TenantScopedClient } from "@brain/api/shared";
import { loadRegistry } from "../schemas.js";
import { extractPlaidTransactions } from "./plaid.js";

function recordingClient(): { client: TenantScopedClient; inserts: string[] } {
  const inserts: string[] = [];
  const client: TenantScopedClient = {
    query: vi.fn(async (text: string, _v?: ReadonlyArray<unknown>) => {
      if (text.startsWith("INSERT INTO wiki_entities")) inserts.push("entity");
      else if (text.startsWith("INSERT INTO wiki_relations")) inserts.push("relation");
      return { rows: [{}], rowCount: 1 } as unknown as {
        rows: Record<string, unknown>[];
        rowCount: number;
      };
    }) as unknown as TenantScopedClient["query"],
  };
  return { client, inserts };
}

describe("extractPlaidTransactions", () => {
  it("creates a transaction entity per posted tx, plus counterparty + relation when merchant present", async () => {
    const reg = loadRegistry();
    const { client, inserts } = recordingClient();

    const res = await extractPlaidTransactions(client, reg, {
      tenantId: "tnt_test",
      rawParsedId: "prs_01HQ7K3ZZZZZZZZZZZZZZZZZZZ",
      accountEntityId: "ent_01HQ7K3AAAAAAAAAAAAAAAAAAAA",
      transactions: [
        {
          transaction_id: "tx_1",
          account_id: "a",
          amount: 4.5,
          iso_currency_code: "USD",
          date: "2026-04-01",
          merchant_name: "Blue Bottle",
          name: "Blue Bottle Coffee",
        },
        {
          transaction_id: "tx_2",
          account_id: "a",
          amount: 2500,
          iso_currency_code: "USD",
          date: "2026-04-01",
        },
        {
          transaction_id: "tx_pending",
          account_id: "a",
          amount: 1,
          iso_currency_code: "USD",
          date: "2026-04-01",
          pending: true,
        },
      ],
    });

    // Pending tx skipped. Two transactions → 2 tx entities + 1 counterparty +
    // 1 transacted_with relation.
    expect(res.entities).toBe(3);
    expect(res.relations).toBe(1);
    expect(inserts.filter((s) => s === "entity")).toHaveLength(3);
    expect(inserts.filter((s) => s === "relation")).toHaveLength(1);
  });
});
