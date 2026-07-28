import { describe, expect, it, vi } from "vitest";
import type { TenantScopedClient } from "@brain/shared";
import { projectCanonicalObligation } from "./obligations.js";

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
});
