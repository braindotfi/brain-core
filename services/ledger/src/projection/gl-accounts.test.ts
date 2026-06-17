import { describe, expect, it } from "vitest";
import { toLedgerGlAccountInput } from "./gl-accounts.js";

describe("toLedgerGlAccountInput", () => {
  it("maps a canonical GL account row to the Ledger projection input, carrying lineage", () => {
    const input = toLedgerGlAccountInput({
      id: "cgla_1",
      source_system: "netsuite",
      source_natural_key: "acct_equip",
      name: "Equipment",
      classification: "asset",
      account_number: "6100",
      currency: "USD",
      status: "ACTIVE",
      source_ids: ["raw_1"],
      evidence_ids: ["prs_1"],
    });
    expect(input).toEqual({
      sourceSystem: "netsuite",
      sourceNaturalKey: "acct_equip",
      canonicalGlAccountId: "cgla_1",
      name: "Equipment",
      classification: "asset",
      accountNumber: "6100",
      currency: "USD",
      status: "ACTIVE",
      sourceIds: ["raw_1"],
      evidenceIds: ["prs_1"],
    });
  });

  it("preserves null provider fields", () => {
    const input = toLedgerGlAccountInput({
      id: "cgla_2",
      source_system: "xero",
      source_natural_key: "k2",
      name: "Misc",
      classification: "unknown",
      account_number: null,
      currency: null,
      status: null,
      source_ids: [],
      evidence_ids: [],
    });
    expect(input.accountNumber).toBeNull();
    expect(input.currency).toBeNull();
    expect(input.canonicalGlAccountId).toBe("cgla_2");
  });
});
