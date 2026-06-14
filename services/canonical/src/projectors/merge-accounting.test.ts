import { describe, expect, it } from "vitest";
import {
  projectGlAccount,
  projectJournalEntry,
  splitSignedAmount,
  toPlainDecimal,
  type ProjectionCommon,
} from "./merge-accounting.js";

const COMMON: ProjectionCommon = {
  provenance: "extracted",
  confidence: null,
  sourceIds: ["raw_1"],
  evidenceIds: ["prs_1"],
};

describe("toPlainDecimal / splitSignedAmount", () => {
  it("accepts numbers and plain decimal strings", () => {
    expect(toPlainDecimal(1250)).toBe("1250");
    expect(toPlainDecimal("1250.50")).toBe("1250.50");
    expect(toPlainDecimal(-42.5)).toBe("-42.5");
  });

  it("rejects exponent, NaN, and non-numeric forms", () => {
    expect(toPlainDecimal(1e21)).toBeNull();
    expect(toPlainDecimal(Number.NaN)).toBeNull();
    expect(toPlainDecimal("1,250")).toBeNull();
    expect(toPlainDecimal(null)).toBeNull();
  });

  it("splits a signed net_amount into direction + non-negative magnitude", () => {
    expect(splitSignedAmount("1250.00")).toEqual({ direction: "debit", amount: "1250.00" });
    expect(splitSignedAmount(-500)).toEqual({ direction: "credit", amount: "500" });
    expect(splitSignedAmount("0")).toEqual({ direction: "debit", amount: "0" });
    expect(splitSignedAmount("garbage")).toBeNull();
  });
});

describe("projectGlAccount", () => {
  it("maps a Merge GL account and retains the verbatim object in extensions", () => {
    const out = projectGlAccount(
      {
        id: "acct_merge_1",
        remote_id: "netsuite-6100",
        name: "Equipment",
        classification: "ASSET",
        account_number: "6100",
        currency: "usd",
        status: "ACTIVE",
      },
      "netsuite",
      COMMON,
    );
    expect(out).not.toBeNull();
    expect(out!.sourceNaturalKey).toBe("acct_merge_1");
    expect(out!.classification).toBe("asset");
    expect(out!.currency).toBe("USD");
    expect(out!.extensions).toEqual({
      merge: expect.objectContaining({ remote_id: "netsuite-6100" }),
    });
    expect(out!.common.evidenceIds).toEqual(["prs_1"]);
  });

  it("falls back to remote_id as the natural key, and rejects an object with neither id", () => {
    expect(projectGlAccount({ remote_id: "r1", name: "X" }, "xero", COMMON)!.sourceNaturalKey).toBe(
      "r1",
    );
    expect(projectGlAccount({ name: "no id" }, "xero", COMMON)).toBeNull();
    expect(projectGlAccount("not an object", "xero", COMMON)).toBeNull();
  });

  it("classifies an unrecognized currency or classification conservatively", () => {
    const out = projectGlAccount(
      { id: "a", classification: "CONTRA", currency: "dollars" },
      "sage",
      COMMON,
    )!;
    expect(out.classification).toBe("unknown");
    expect(out.currency).toBeNull();
  });
});

describe("projectJournalEntry", () => {
  it("maps a balanced entry to debit/credit legs with line numbers", () => {
    const out = projectJournalEntry(
      {
        id: "je_1",
        transaction_date: "2026-06-01T00:00:00Z",
        memo: "Equipment purchase",
        currency: "USD",
        posting_status: "POSTED",
        lines: [
          { account: "acct_merge_1", net_amount: "1250.00", description: "Asset" },
          { account: "acct_merge_2", net_amount: "-1250.00", description: "Cash" },
        ],
      },
      "netsuite",
      COMMON,
    );
    expect(out).not.toBeNull();
    expect(out!.sourceNaturalKey).toBe("je_1");
    expect(out!.postedAt).toBe("2026-06-01T00:00:00Z");
    expect(out!.status).toBe("POSTED");
    expect(out!.lines).toHaveLength(2);
    expect(out!.lines[0]).toMatchObject({
      lineNumber: 1,
      glAccountKey: "acct_merge_1",
      direction: "debit",
      amount: "1250.00",
    });
    expect(out!.lines[1]).toMatchObject({
      lineNumber: 2,
      direction: "credit",
      amount: "1250.00",
    });
  });

  it("inherits entry currency on lines that omit one, and skips amount-less lines", () => {
    const out = projectJournalEntry(
      {
        id: "je_2",
        currency: "EUR",
        lines: [
          { account: "a", net_amount: 100 },
          { account: "b" /* no net_amount */ },
          { account: "c", net_amount: -100, currency: "gbp" },
        ],
      },
      "xero",
      COMMON,
    )!;
    expect(out.lines).toHaveLength(2); // the amount-less line is dropped
    expect(out.lines[0]!.currency).toBe("EUR"); // inherited
    expect(out.lines[1]!.currency).toBe("GBP"); // line override
    expect(out.lines[1]!.lineNumber).toBe(2); // numbering is over kept lines
  });

  it("rejects an entry with no id", () => {
    expect(projectJournalEntry({ lines: [] }, "sage", COMMON)).toBeNull();
  });
});
