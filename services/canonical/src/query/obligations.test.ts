import { describe, expect, it } from "vitest";
import { toObligationProduct } from "./obligations.js";

const ROW = {
  id: "cob_1",
  direction: "payable",
  type: "bill",
  canonical_counterparty_id: "ccp_1",
  amount: "1250.00000000",
  currency: "USD",
  issue_date: new Date("2026-06-01T00:00:00Z"),
  due_date: new Date("2026-07-01T00:00:00Z"),
  status: "due",
  source_system: "netsuite",
  source_natural_key: "merge_inv_77",
  schema_version: 1,
  provenance: "extracted",
  confidence: 0.85,
  source_ids: ["raw_1"],
  evidence_ids: ["prs_1"],
  extensions: { merge: { remote_id: "netsuite-4411" } },
  updated_at: new Date("2026-06-02T12:00:00Z"),
  projected_at: new Date("2026-06-02T12:00:00Z"),
  projector: "merge_accounting_canonical_v1",
};

describe("toObligationProduct", () => {
  it("shapes a row into the governed data-product envelope (record + provenance + freshness)", () => {
    const p = toObligationProduct(ROW);
    expect(p.domain).toBe("ap_ar");
    expect(p.record).toMatchObject({
      id: "cob_1",
      direction: "payable",
      amount: "1250.00000000",
      due_date: "2026-07-01T00:00:00.000Z",
      source_natural_key: "merge_inv_77",
    });
    // Provenance travels with the value (never a number without its evidence).
    expect(p.provenance).toEqual({
      provenance: "extracted",
      confidence: 0.85,
      source_ids: ["raw_1"],
      evidence_ids: ["prs_1"],
    });
    expect(p.freshness.projector).toBe("merge_accounting_canonical_v1");
    expect(p.freshness.projected_at).toBe("2026-06-02T12:00:00.000Z");
    expect(p.freshness.source_system).toBe("netsuite");
  });

  it("tolerates an unlogged record (no projection-log freshness) and null dates", () => {
    const p = toObligationProduct({
      ...ROW,
      issue_date: null,
      due_date: null,
      confidence: null,
      projected_at: null,
      projector: null,
    });
    expect(p.record.issue_date).toBeNull();
    expect(p.record.due_date).toBeNull();
    expect(p.provenance.confidence).toBeNull();
    expect(p.freshness.projected_at).toBeNull();
    expect(p.freshness.projector).toBeNull();
    expect(p.freshness.updated_at).toBe("2026-06-02T12:00:00.000Z"); // always present
  });
});
