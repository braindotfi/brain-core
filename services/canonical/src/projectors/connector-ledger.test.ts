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

  it("covers Plaid fallback and skip branches", () => {
    const diag = { skippedRows: {} };
    const out = projectPlaidLedger(
      {
        accounts: [
          { account_id: "save_1", name: "Savings", type: "depository", subtype: "savings" },
          { account_id: "card_1", name: "Card", type: "credit" },
          { account_id: "loc_1", name: "LOC", type: "credit", subtype: "line of credit" },
          { account_id: "loan_1", name: "Loan", type: "loan" },
          { account_id: 42, name: "Bad", type: "depository" },
        ],
        transactions: [
          {
            transaction_id: "tx_in",
            account_id: "save_1",
            amount: -20,
            date: "2026-07-02",
            name: "Deposit",
            pending: true,
          },
          { transaction_id: "bad", account_id: "save_1", amount: "no", date: "2026-07-02" },
        ],
      },
      common,
      diag,
    );

    expect(out.filter((p) => p.kind === "account").map((p) => p.input.accountType)).toEqual([
      "bank_savings",
      "card",
      "line_of_credit",
      "loan",
    ]);
    expect(out.at(-1)).toMatchObject({
      kind: "transaction",
      input: {
        sourceNaturalKey: "tx_in",
        direction: "inflow",
        status: "pending",
        descriptionRaw: "Deposit",
      },
    });
    expect(diag.skippedRows).toMatchObject({
      plaid_account_missing_id: 1,
      plaid_transaction_missing_required_field: 1,
    });
  });

  it("rejects non-object connector payloads", () => {
    expect(() => projectPlaidLedger(null, common)).toThrow(/plaid payload/);
    expect(() => projectStripeLedger(null, common)).toThrow(/stripe payload/);
    expect(() => projectFinchLedger(null, common)).toThrow(/finch payload/);
  });

  it("rejects connector payloads missing object_type where required", () => {
    expect(() => projectStripeLedger({ objects: [] }, common)).toThrow(/object_type/);
    expect(() => projectFinchLedger({ objects: [] }, common)).toThrow(/object_type/);
  });

  it("projects Stripe customers and transaction object variants", () => {
    const charge = projectStripeLedger(
      {
        object_type: "charge",
        stripe_account_id: "acct_S1",
        objects: [
          {
            id: "ch_1",
            amount: 2500,
            currency: "usd",
            created: 1,
            paid: false,
            customer: "cus_1",
            description: "Invoice charge",
          },
        ],
      },
      common,
    );
    const payout = projectStripeLedger(
      {
        object_type: "payout",
        stripe_account_id: "acct_S1",
        objects: [{ id: "po_1", amount: 7000, currency: "usd", created: 2 }],
      },
      common,
    );
    const refund = projectStripeLedger(
      {
        object_type: "refund",
        stripe_account_id: "acct_S1",
        objects: [{ id: "re_1", amount: 300, currency: "usd", created: 3 }],
      },
      common,
    );
    const fee = projectStripeLedger(
      {
        object_type: "balance_transaction",
        stripe_account_id: "acct_S1",
        objects: [
          { id: "txn_charge", type: "charge", amount: 7000, currency: "usd", created: 4 },
          { id: "txn_fee", type: "stripe_fee", fee: 123, currency: "usd", created: 5 },
        ],
      },
      common,
    );
    const customer = projectStripeLedger(
      {
        object_type: "customer",
        objects: [{ id: "cus_1", email: "billing@example.com" }],
      },
      common,
    );

    expect(charge[1]).toMatchObject({
      kind: "transaction",
      input: {
        sourceNaturalKey: "ch_1",
        direction: "inflow",
        status: "pending",
        counterpartySourceKey: "customer:cus_1",
      },
    });
    expect(payout[1]).toMatchObject({ kind: "transaction", input: { direction: "outflow" } });
    expect(refund[1]).toMatchObject({ kind: "transaction", input: { direction: "outflow" } });
    expect(fee.map((p) => p.kind)).toEqual(["account", "transaction"]);
    expect(fee[1]).toMatchObject({ kind: "transaction", input: { sourceNaturalKey: "txn_fee" } });
    expect(customer).toEqual([
      expect.objectContaining({
        kind: "counterparty",
        input: expect.objectContaining({
          sourceNaturalKey: "customer:cus_1",
          name: "billing@example.com",
          email: "billing@example.com",
        }),
      }),
    ]);
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

  it("projects Finch individuals and completed pay runs", () => {
    const individual = projectFinchLedger(
      {
        object_type: "individual",
        objects: [
          {
            id: "ind_1",
            first_name: "Dana",
            last_name: "Reyes",
            email: "dana@example.com",
          },
          { id: 42 },
        ],
      },
      common,
    );
    const completed = projectFinchLedger(
      {
        object_type: "pay_run",
        objects: [
          {
            id: "pay_done",
            payment_date: "2020-07-20",
            net_pay: { amount: 420000 },
            description: "July payroll",
          },
          { id: "pay_bad", pay_date: "2020-07-20", net_pay: { amount: 1.2 } },
        ],
      },
      common,
    );
    const ignored = projectFinchLedger({ object_type: "pay_statement", objects: [] }, common);

    expect(individual).toEqual([
      expect.objectContaining({
        kind: "counterparty",
        input: expect.objectContaining({
          sourceNaturalKey: "individual:ind_1",
          name: "Dana Reyes",
          type: "employee",
        }),
      }),
    ]);
    expect(completed.map((p) => p.kind)).toEqual(["account", "transaction"]);
    expect(completed[1]).toMatchObject({
      kind: "transaction",
      input: {
        sourceNaturalKey: "pay_run:pay_done",
        amount: "4200.00",
        descriptionRaw: "July payroll",
      },
    });
    expect(ignored).toEqual([]);
  });
});
