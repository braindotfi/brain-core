import { describe, expect, it } from "vitest";
import { toGlAccountProduct } from "./gl-accounts.js";

const ROW = {
  id: "cgla_1",
  name: "Equipment",
  classification: "asset",
  account_number: "6100",
  currency: "USD",
  status: "ACTIVE",
  source_system: "netsuite",
  source_natural_key: "acct_equip",
  schema_version: 1,
  provenance: "extracted",
  confidence: null,
  source_ids: ["raw_1"],
  evidence_ids: ["prs_1"],
  extensions: { merge: { remote_id: "netsuite-6100" } },
  updated_at: new Date("2026-06-02T12:00:00Z"),
  projected_at: new Date("2026-06-02T12:00:00Z"),
  projector: "merge_accounting_canonical_v1",
};

describe("toGlAccountProduct", () => {
  it("shapes a GL account row into the governed envelope (record + provenance + freshness)", () => {
    const p = toGlAccountProduct(ROW);
    expect(p.domain).toBe("accounting");
    expect(p.record).toMatchObject({
      id: "cgla_1",
      classification: "asset",
      account_number: "6100",
      source_natural_key: "acct_equip",
    });
    expect(p.provenance).toEqual({
      provenance: "extracted",
      confidence: null,
      source_ids: ["raw_1"],
      evidence_ids: ["prs_1"],
    });
    expect(p.freshness.projector).toBe("merge_accounting_canonical_v1");
    expect(p.freshness.projected_at).toBe("2026-06-02T12:00:00.000Z");
  });

  it("tolerates an unlogged record + null provider fields", () => {
    const p = toGlAccountProduct({
      ...ROW,
      account_number: null,
      currency: null,
      status: null,
      projected_at: null,
      projector: null,
    });
    expect(p.record.account_number).toBeNull();
    expect(p.freshness.projected_at).toBeNull();
    expect(p.freshness.updated_at).toBe("2026-06-02T12:00:00.000Z");
  });
});
