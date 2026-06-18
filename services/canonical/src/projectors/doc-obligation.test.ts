import { describe, expect, it } from "vitest";
import { DOCUMENT_SOURCE_SYSTEM, projectDocObligation } from "./doc-obligation.js";
import type { ProjectionCommon } from "./merge-accounting.js";

const COMMON: ProjectionCommon = {
  provenance: "agent_contributed",
  confidence: 0.45,
  sourceIds: ["raw_doc1"],
  evidenceIds: ["prs_doc1"],
};

const PAYLOAD = {
  counterparty_name: "Acme Industrial Supply",
  direction: "payable",
  type: "bill",
  amount: "1250.00",
  currency: "usd",
  due_date: "2026-07-01T00:00:00Z",
  status: "due",
};

describe("projectDocObligation", () => {
  it("maps a document payload to a canonical counterparty + obligation, low-trust", () => {
    const out = projectDocObligation(PAYLOAD, "raw_doc1", COMMON)!;
    expect(out).not.toBeNull();
    expect(out.obligation.sourceSystem).toBe(DOCUMENT_SOURCE_SYSTEM);
    expect(out.obligation.sourceNaturalKey).toBe("raw_doc1"); // the document artifact id
    expect(out.obligation.direction).toBe("payable");
    expect(out.obligation.type).toBe("bill");
    expect(out.obligation.amount).toBe("1250.00");
    expect(out.obligation.currency).toBe("USD");
    expect(out.obligation.common.provenance).toBe("agent_contributed");
    // Counterparty keyed on normalized name; obligation links to it by that key.
    expect(out.counterparty.sourceNaturalKey).toBe("acme_industrial_supply");
    expect(out.obligation.counterpartySourceKey).toBe("acme_industrial_supply");
    expect(out.counterparty.type).toBe("vendor");
  });

  it("resolves a customer counterparty for a receivable", () => {
    const out = projectDocObligation({ ...PAYLOAD, direction: "receivable" }, "raw_x", COMMON)!;
    expect(out.counterparty.type).toBe("customer");
  });

  it("returns null on a payload missing essentials", () => {
    expect(projectDocObligation({ ...PAYLOAD, counterparty_name: "" }, "r", COMMON)).toBeNull();
    expect(projectDocObligation({ ...PAYLOAD, direction: "sideways" }, "r", COMMON)).toBeNull();
    expect(projectDocObligation({ ...PAYLOAD, amount: undefined }, "r", COMMON)).toBeNull();
  });
});
