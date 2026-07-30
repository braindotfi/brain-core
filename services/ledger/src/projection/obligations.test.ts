import { describe, expect, it, vi } from "vitest";
import type { TenantScopedClient } from "@brain/shared";
import { projectCanonicalObligation, runLedgerAparProjectionCycle } from "./obligations.js";

function clientWithCounterparty(): {
  client: TenantScopedClient;
  calls: { text: string; values: unknown[] }[];
} {
  const calls: { text: string; values: unknown[] }[] = [];
  const client = {
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      if (text.includes("SELECT id FROM ledger_counterparties")) {
        return { rows: [{ id: "cp_1" }], rowCount: 1 };
      }
      if (text.includes("SELECT id FROM canonical_counterparty")) {
        return { rows: [{ id: "cc_repaired" }], rowCount: 1 };
      }
      if (text.includes("UPDATE canonical_obligation")) {
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("INSERT INTO ledger_obligations")) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
  } as unknown as TenantScopedClient;
  return { client, calls };
}

const BASE_OBLIGATION = {
  id: "co_1",
  tenant_id: "tnt_1",
  source_natural_key: "inv_1",
  source_system: "document_upload",
  direction: "payable",
  type: "bill",
  canonical_counterparty_id: "cc_1",
  counterparty_source_key: "vendor_acme",
  amount: "42.00",
  issue_date: null,
  due_date: "2026-07-01T00:00:00Z",
  status: "OPEN",
  provenance: "extracted",
  confidence: 0.85,
  source_ids: ["raw_1"],
  evidence_ids: ["prs_1"],
  extensions: {},
};

describe("projectCanonicalObligation", () => {
  it("defaults null currency to USD for legacy canonical rows", async () => {
    const { client, calls } = clientWithCounterparty();

    await expect(
      projectCanonicalObligation(client, "tnt_1", { ...BASE_OBLIGATION, currency: null }),
    ).resolves.toBe(true);

    const insert = calls.find((c) => c.text.includes("INSERT INTO ledger_obligations"))!;
    expect(insert.values).toContain("USD");
  });

  it("rejects a non-null malformed currency instead of folding it into USD", async () => {
    const { client, calls } = clientWithCounterparty();

    await expect(
      projectCanonicalObligation(client, "tnt_1", { ...BASE_OBLIGATION, currency: "usd" }),
    ).rejects.toThrow(/currency must be a 3-letter ISO 4217 code/);

    expect(calls.some((c) => c.text.includes("INSERT INTO ledger_obligations"))).toBe(false);
  });

  it("repairs a missing canonical counterparty link from the source key before projecting", async () => {
    const { client, calls } = clientWithCounterparty();

    await expect(
      projectCanonicalObligation(client, "tnt_1", {
        ...BASE_OBLIGATION,
        canonical_counterparty_id: null,
        currency: "USD",
      }),
    ).resolves.toBe(true);

    const repair = calls.find((c) => c.text.includes("UPDATE canonical_obligation"));
    expect(repair?.values).toEqual(["cc_repaired", "tnt_1", "co_1"]);

    const ledgerLookup = calls.find((c) => c.text.includes("SELECT id FROM ledger_counterparties"));
    expect(ledgerLookup?.values).toEqual(["tnt_1", "cc_repaired"]);

    expect(calls.some((c) => c.text.includes("INSERT INTO ledger_obligations"))).toBe(true);
  });

  it("repairs a cross-tenant canonical counterparty link before projecting", async () => {
    const calls: { text: string; values: unknown[] }[] = [];
    const client = {
      query: vi.fn(async (text: string, values: unknown[] = []) => {
        calls.push({ text, values });
        if (text.includes("WHERE tenant_id = $1 AND id = $2")) {
          return { rows: [], rowCount: 0 };
        }
        if (text.includes("WHERE tenant_id = $1 AND source_system = $2")) {
          return { rows: [{ id: "cc_same_tenant" }], rowCount: 1 };
        }
        if (text.includes("SELECT id FROM ledger_counterparties")) {
          return { rows: [{ id: "cp_same_tenant" }], rowCount: 1 };
        }
        if (text.includes("INSERT INTO ledger_obligations")) {
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    } as unknown as TenantScopedClient;

    await expect(
      projectCanonicalObligation(client, "tnt_1", {
        ...BASE_OBLIGATION,
        canonical_counterparty_id: "cc_other_tenant",
        currency: "USD",
      }),
    ).resolves.toBe(true);

    const repair = calls.find((c) => c.text.includes("UPDATE canonical_obligation"));
    expect(repair?.values).toEqual(["cc_same_tenant", "tnt_1", "co_1"]);
    const ledgerLookup = calls.find((c) => c.text.includes("SELECT id FROM ledger_counterparties"));
    expect(ledgerLookup?.values).toEqual(["tnt_1", "cc_same_tenant"]);
  });

  it("mirrors receivable invoice obligations into ledger_invoices", async () => {
    const { client, calls } = clientWithCounterparty();

    await expect(
      projectCanonicalObligation(client, "tnt_1", {
        ...BASE_OBLIGATION,
        direction: "receivable",
        type: "invoice",
        source_natural_key: "ar:NL-2417",
        amount: "500.00",
        currency: "USD",
        issue_date: null,
        due_date: "2026-05-22T00:00:00Z",
        extensions: { document_upload: { invoice_ref: "NL-2417" } },
      }),
    ).resolves.toBe(true);

    const invoice = calls.find((c) => c.text.includes("INSERT INTO ledger_invoices"));
    expect(invoice).toBeDefined();
    expect(invoice?.values[2]).toBe("NL-2417");
    expect(invoice?.values[4]).toBe("500.00");
    expect(invoice?.values[14]).toBe("co_1");
  });
});

describe("runLedgerAparProjectionCycle", () => {
  it("selects source_natural_key for obligation projection", async () => {
    const queries: string[] = [];
    const pool = {
      query: vi.fn(async (text: string) => {
        queries.push(text);
        return { rows: [], rowCount: 0 };
      }),
    };

    await runLedgerAparProjectionCycle({ pool: pool as never });

    const obligationQuery = queries.find((q) => q.includes("FROM canonical_obligation co"));
    expect(obligationQuery).toContain("co.source_natural_key");
  });
});
