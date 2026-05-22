import { describe, expect, it } from "vitest";
import {
  ServiceEvidenceGatherer,
  StaticEvidenceGatherer,
  evidenceCompleteness,
} from "./evidence-gatherer.js";
import type { Evidence } from "@brain/internal-agents";

const items: Evidence[] = [
  { kind: "invoice", ref: "inv_1" },
  { kind: "counterparty", ref: "cp_1" },
];

describe("evidenceCompleteness", () => {
  it("is 1 when no evidence is required", () => {
    expect(evidenceCompleteness(items, [])).toBe(1);
  });
  it("is the fraction of required kinds present", () => {
    expect(evidenceCompleteness(items, ["invoice", "counterparty"])).toBe(1);
    expect(evidenceCompleteness(items, ["invoice", "balance"])).toBe(0.5);
    expect(evidenceCompleteness([], ["invoice"])).toBe(0);
  });
});

describe("StaticEvidenceGatherer", () => {
  it("returns its items and computed completeness", async () => {
    const g = new StaticEvidenceGatherer(items);
    const bundle = await g.gather({ tenantId: "tnt_acme", requiredEvidence: ["invoice"] });
    expect(bundle.items).toHaveLength(2);
    expect(bundle.completeness).toBe(1);
  });
});

describe("ServiceEvidenceGatherer", () => {
  it("merges wiki citations and ledger references", async () => {
    const g = new ServiceEvidenceGatherer({
      wiki: async () => [{ kind: "wiki_citation", ref: "page_1", excerpt: "Vendor X overdue" }],
      ledger: async () => [{ kind: "invoice", ref: "inv_1" }],
    });
    const bundle = await g.gather({
      tenantId: "tnt_acme",
      requiredEvidence: ["invoice", "wiki_citation"],
    });
    expect(bundle.items.map((i) => i.kind).sort()).toEqual(["invoice", "wiki_citation"]);
    expect(bundle.completeness).toBe(1);
  });

  it("tolerates missing providers", async () => {
    const g = new ServiceEvidenceGatherer({});
    const bundle = await g.gather({ tenantId: "tnt_acme", requiredEvidence: [] });
    expect(bundle.items).toEqual([]);
    expect(bundle.completeness).toBe(1);
  });
});
