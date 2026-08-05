import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { newTenantId, type TenantScopedClient } from "@brain/shared";
import {
  projectCanonicalAccount,
  runLedgerAccountTransactionProjectionCycle,
} from "./accounts-transactions.js";

const BASE_ACCOUNT = {
  id: "ca_1",
  tenant_id: "tnt_1",
  institution: "Mercury",
  external_account_id: "acc_1",
  account_type: "bank_checking",
  name: "Operating",
  currency: "USD",
  current_balance: "1000.00",
  available_balance: "900.00",
  status: "active",
  provenance: "extracted",
  confidence: 0.9,
  source_ids: ["raw_1"],
  evidence_ids: ["prs_1"],
};

function clientStub(): {
  client: TenantScopedClient;
  calls: { text: string; values: unknown[] }[];
} {
  const calls: { text: string; values: unknown[] }[] = [];
  const client = {
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      if (text.includes("INSERT INTO ledger_accounts"))
        return { rows: [{ id: "la_1" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }),
  } as unknown as TenantScopedClient;
  return { client, calls };
}

describe("projectCanonicalAccount", () => {
  it("projects a canonical account into ledger_accounts", async () => {
    const { client, calls } = clientStub();
    await expect(projectCanonicalAccount(client, "tnt_1", BASE_ACCOUNT)).resolves.toBe("la_1");
    expect(calls.some((c) => c.text.includes("INSERT INTO ledger_accounts"))).toBe(true);
  });
});

describe("runLedgerAccountTransactionProjectionCycle", () => {
  // F1 regression: a single poison account row must not throw out of the
  // whole batch loop and block every other tenant's account/transaction
  // projection behind it.
  it("quarantines a poison account row without blocking its siblings", async () => {
    const tenantBad = newTenantId();
    const tenantGood = newTenantId();
    const badAccount = {
      ...BASE_ACCOUNT,
      id: "ca_bad",
      tenant_id: tenantBad,
      current_balance: "1".repeat(21),
    };
    const goodAccount = {
      ...BASE_ACCOUNT,
      id: "ca_good",
      tenant_id: tenantGood,
      current_balance: "1000.00",
    };

    const insertedBalances: string[] = [];
    const client = {
      query: vi.fn(async (text: string, values: unknown[] = []) => {
        if (text.includes("INSERT INTO ledger_accounts")) {
          insertedBalances.push(values[7] as string);
          return { rows: [{ id: "la_1" }], rowCount: 1 };
        }
        if (text.includes("INSERT INTO ledger_projection_quarantine")) {
          return { rows: [{ attempts: 1, quarantined: false }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: async () => client,
      query: vi.fn(async (text: string) => {
        if (text.includes("FROM canonical_account ca")) {
          return { rows: [badAccount, goodAccount], rowCount: 2 };
        }
        return { rows: [], rowCount: 0 };
      }),
    } as unknown as Pool;

    await runLedgerAccountTransactionProjectionCycle({ pool });

    // The good account's insert still ran even though the bad one threw
    // before ever reaching the query.
    expect(insertedBalances).toEqual(["1000.00"]);
  });
});
