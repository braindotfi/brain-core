import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { newTenantId, newUserId } from "@brain/shared";
import { resolveAccountView } from "./resolveAccount.js";

function fakePool(routes: Record<string, Array<Record<string, unknown>>>): Pool {
  const client = {
    query: vi.fn(async (text: string) => {
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(text.trim())) return { rows: [], rowCount: 0 };
      if (text.startsWith("SELECT set_config")) return { rows: [], rowCount: 0 };
      for (const [needle, rows] of Object.entries(routes)) {
        if (text.includes(needle)) return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  return { connect: async () => client } as unknown as Pool;
}

const ctx = { tenantId: newTenantId(), actor: newUserId() };

function obs(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    account_id: "acct_plaid",
    external_account_id: "plaid_acc_ops",
    name: "Operating Checking",
    institution: "Chase",
    account_type: "bank_checking",
    currency: "USD",
    current_balance: "84000.00",
    available_balance: "84000.00",
    provenance: "extracted",
    confidence: 0.95,
    source_ids: ["raw_plaid"],
    ...over,
  };
}

describe("resolveAccountView", () => {
  it("resolves a human-confirmed link into one account, balances per observation", async () => {
    const pool = fakePool({
      "FROM ledger_reconciliation_matches": [
        {
          id: "rcn_acct1",
          left_entity_id: "acct_erp",
          right_entity_id: "acct_plaid",
          status: "matched", // a human confirmed the candidate
          confidence_score: 0.76,
        },
      ],
      "FROM ledger_accounts": [
        obs(),
        obs({
          account_id: "acct_erp",
          external_account_id: "gl-1000-cash",
          name: "Cash - Operating",
          current_balance: "83500.00",
          confidence: 0.8,
        }),
      ],
    });

    const view = await resolveAccountView(pool, ctx, "acct_plaid");
    expect(view).not.toBeNull();
    expect(view!.observations).toHaveLength(2);
    expect(view!.resolved.member_ids).toEqual(["acct_erp", "acct_plaid"]);
    // Strongest independent observation names the pool; balance variance is
    // observation data (timing), not a conflict to adjudicate.
    expect(view!.resolved.name.value).toBe("Operating Checking");
    expect(view!.observations.map((o) => o.current_balance).sort()).toEqual([
      "83500.00",
      "84000.00",
    ]);
    expect(view!.observations[0]!.source_ids).toEqual(["raw_plaid"]);
  });

  it("keeps candidates out of the member set, surfaced for review", async () => {
    const pool = fakePool({
      "FROM ledger_reconciliation_matches": [
        {
          id: "rcn_acct2",
          left_entity_id: "acct_maybe",
          right_entity_id: "acct_plaid",
          status: "duplicate_possible",
          confidence_score: 0.7,
        },
      ],
      "FROM ledger_accounts": [obs()],
    });
    const view = await resolveAccountView(pool, ctx, "acct_plaid");
    expect(view!.resolved.member_ids).toEqual(["acct_plaid"]);
    expect(view!.pending_review).toEqual([
      { match_id: "rcn_acct2", counter_account_id: "acct_maybe", confidence_score: 0.7 },
    ]);
  });

  it("returns null for an unknown account", async () => {
    const pool = fakePool({
      "FROM ledger_reconciliation_matches": [],
      "FROM ledger_accounts": [],
    });
    expect(await resolveAccountView(pool, ctx, "acct_ghost")).toBeNull();
  });
});
