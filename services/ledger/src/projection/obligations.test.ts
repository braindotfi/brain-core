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
  direction: "payable",
  type: "bill",
  canonical_counterparty_id: "cc_1",
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
});
