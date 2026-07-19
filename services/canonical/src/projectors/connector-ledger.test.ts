import { describe, expect, it } from "vitest";
import { projectFinchLedger, projectPlaidLedger, projectStripeLedger } from "./connector-ledger.js";
import type { ProjectionCommon } from "./merge-accounting.js";

const common: ProjectionCommon = {
  provenance: "extracted",
  confidence: null,
  sourceIds: ["raw_1"],
  evidenceIds: ["prs_1"],
};

describe("connector ledger canonical projectors", () => {
  it("projects Plaid accounts, counterparties, and transactions into canonical shapes", () => {
    const out = projectPlaidLedger(
      {
        institution_name: "Bank",
        accounts: [
          {
            account_id: "acc_1",
            name: "Operating",
            type: "depository",
            subtype: "checking",
            iso_currency_code: "usd",
            balances: { current: 100, available: 80 },
          },
        ],
        transactions: [
          {
            transaction_id: "tx_1",
            account_id: "acc_1",
            amount: 12.34,
            iso_currency_code: "usd",
            date: "2026-07-01",
            merchant_name: "Blue Bottle",
            pending: false,
          },
        ],
      },
      common,
    );

    expect(out.map((p) => p.kind)).toEqual(["account", "counterparty", "transaction"]);
    expect(out[0]).toMatchObject({
      kind: "account",
      input: { sourceSystem: "plaid", sourceNaturalKey: "acc_1", accountType: "bank_checking" },
    });
    expect(out[2]).toMatchObject({
      kind: "transaction",
      input: {
        sourceSystem: "plaid",
        sourceNaturalKey: "tx_1",
        amount: "12.34",
        direction: "outflow",
        reconciliationStatus: "unreconciled",
      },
    });
  });

  it("quarantines malformed currency by throwing from the projector", () => {
    expect(() =>
      projectPlaidLedger(
        {
          accounts: [
            {
              account_id: "acc_1",
              name: "Operating",
              type: "depository",
              iso_currency_code: "usdollars",
            },
          ],
        },
        common,
      ),
    ).toThrow(/currency/);
  });

  it("projects Stripe disputes into canonical counterparty and obligation records", () => {
    const out = projectStripeLedger(
      {
        object_type: "dispute",
        stripe_account_id: "acct_S1",
        objects: [{ id: "dp_1", amount: 125000, currency: "usd", status: "needs_response" }],
      },
      common,
    );

    expect(out.map((p) => p.kind)).toEqual(["counterparty", "obligation"]);
    expect(out[1]).toMatchObject({
      kind: "obligation",
      input: {
        sourceSystem: "stripe",
        sourceNaturalKey: "dispute:dp_1",
        amount: "1250.00",
        direction: "payable",
      },
    });
  });

  it("projects Finch future pay runs into canonical payroll obligations", () => {
    const out = projectFinchLedger(
      {
        object_type: "pay_run",
        objects: [
          {
            id: "pay_1",
            pay_date: "2999-07-20",
            company_debit: { amount: 500000 },
          },
        ],
      },
      common,
    );

    expect(out.map((p) => p.kind)).toEqual(["account", "counterparty", "obligation"]);
    expect(out[2]).toMatchObject({
      kind: "obligation",
      input: {
        sourceSystem: "finch",
        sourceNaturalKey: "pay_run:pay_1",
        amount: "5000.00",
        type: "payroll",
      },
    });
  });
});
