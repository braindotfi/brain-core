import { describe, expect, it } from "vitest";
import { toJournalEntryProduct } from "./journal-entries.js";

const ROW = {
  id: "cje_1",
  posted_at: new Date("2026-06-01T00:00:00Z"),
  memo: "Equipment purchase",
  currency: "USD",
  status: "POSTED",
  source_system: "netsuite",
  source_natural_key: "je_77",
  schema_version: 1,
  provenance: "extracted",
  confidence: null,
  source_ids: ["raw_1"],
  evidence_ids: ["prs_1"],
  extensions: {},
  updated_at: new Date("2026-06-02T12:00:00Z"),
  projected_at: new Date("2026-06-02T12:00:00Z"),
  projector: "merge_accounting_canonical_v1",
  lines: [
    {
      line_number: 1,
      gl_account_id: "cgla_1",
      gl_account_key: "acct_equip",
      direction: "debit",
      amount: "1250.00000000",
      currency: "USD",
      description: "Asset",
    },
    {
      line_number: 2,
      gl_account_id: "cgla_2",
      gl_account_key: "acct_cash",
      direction: "credit",
      amount: "1250.00000000",
      currency: "USD",
      description: "Cash",
    },
  ],
};

describe("toJournalEntryProduct", () => {
  it("shapes a journal entry (header + double-entry lines) into the governed envelope", () => {
    const p = toJournalEntryProduct(ROW);
    expect(p.domain).toBe("accounting");
    expect(p.record.posted_at).toBe("2026-06-01T00:00:00.000Z");
    expect(p.record.lines).toHaveLength(2);
    expect(p.record.lines.map((l) => l.direction)).toEqual(["debit", "credit"]);
    expect(p.record.lines[0]!.gl_account_id).toBe("cgla_1");
    expect(p.provenance.provenance).toBe("extracted");
    expect(p.freshness.projector).toBe("merge_accounting_canonical_v1");
  });

  it("handles an entry with no posted date / no lines", () => {
    const p = toJournalEntryProduct({ ...ROW, posted_at: null, lines: [] });
    expect(p.record.posted_at).toBeNull();
    expect(p.record.lines).toEqual([]);
    expect(p.freshness.updated_at).toBe("2026-06-02T12:00:00.000Z");
  });
});
