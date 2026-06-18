import { describe, expect, it } from "vitest";
import { normalizeName, projectMergeContact, projectMergeInvoice } from "./merge-apar.js";
import type { ProjectionCommon } from "./merge-accounting.js";

const COMMON: ProjectionCommon = {
  provenance: "extracted",
  confidence: null,
  sourceIds: ["raw_1"],
  evidenceIds: ["prs_1"],
};

describe("normalizeName", () => {
  it("lowercases and collapses non-alphanumerics to underscores", () => {
    expect(normalizeName("Acme Industrial Supply, Inc.")).toBe("acme_industrial_supply_inc");
    expect(normalizeName("  Globex   Corp  ")).toBe("globex_corp");
  });
});

describe("projectMergeContact", () => {
  it("maps a supplier to a vendor counterparty with normalized name + lowercased email", () => {
    const out = projectMergeContact(
      { id: "con_1", name: "Acme Supply", is_supplier: true, email_address: "AP@Acme.example" },
      "netsuite",
      COMMON,
    );
    expect(out).not.toBeNull();
    expect(out!.type).toBe("vendor");
    expect(out!.sourceNaturalKey).toBe("con_1");
    expect(out!.normalizedName).toBe("acme_supply");
    expect(out!.email).toBe("ap@acme.example");
    expect(out!.extensions).toEqual({ merge: expect.objectContaining({ id: "con_1" }) });
  });

  it("maps a customer, and falls back to other when neither flag is set", () => {
    expect(projectMergeContact({ id: "c", is_customer: true }, "xero", COMMON)!.type).toBe(
      "customer",
    );
    expect(projectMergeContact({ id: "c2", name: "X" }, "xero", COMMON)!.type).toBe("other");
  });

  it("rejects an object with no id", () => {
    expect(projectMergeContact({ name: "no id" }, "sage", COMMON)).toBeNull();
    expect(projectMergeContact(42, "sage", COMMON)).toBeNull();
  });
});

describe("projectMergeInvoice", () => {
  it("maps an AP invoice to a payable bill, preferring outstanding balance", () => {
    const out = projectMergeInvoice(
      {
        id: "inv_1",
        type: "ACCOUNTS_PAYABLE",
        contact: "con_1",
        number: "BILL-1004",
        issue_date: "2026-06-01",
        due_date: "2026-07-01",
        total_amount: "1250.00",
        balance: "1000.00",
        currency: "usd",
        status: "OPEN",
        line_items: [{ account: "acct_6100" }, { account: "acct_6200" }],
      },
      "netsuite",
      COMMON,
    );
    expect(out).not.toBeNull();
    expect(out!.direction).toBe("payable");
    expect(out!.type).toBe("bill");
    expect(out!.counterpartySourceKey).toBe("con_1");
    expect(out!.amount).toBe("1000.00"); // balance preferred over total
    expect(out!.currency).toBe("USD");
    expect(out!.extensions).toEqual({
      merge: expect.objectContaining({
        number: "BILL-1004",
        gl_accounts: ["acct_6100", "acct_6200"],
      }),
    });
  });

  it("maps an AR invoice to a receivable, and falls back to total when no balance", () => {
    const out = projectMergeInvoice(
      { id: "inv_2", type: "ACCOUNTS_RECEIVABLE", total_amount: 500, currency: "EUR" },
      "xero",
      COMMON,
    )!;
    expect(out.direction).toBe("receivable");
    expect(out.type).toBe("invoice");
    expect(out.amount).toBe("500");
  });

  it("skips non-AP/AR invoices, negative amounts, and id-less objects", () => {
    expect(
      projectMergeInvoice({ id: "i", type: "OTHER", total_amount: "5" }, "x", COMMON),
    ).toBeNull();
    expect(
      projectMergeInvoice({ id: "i", type: "ACCOUNTS_PAYABLE", balance: "-5" }, "x", COMMON),
    ).toBeNull();
    expect(
      projectMergeInvoice({ type: "ACCOUNTS_PAYABLE", total_amount: "5" }, "x", COMMON),
    ).toBeNull();
  });
});
