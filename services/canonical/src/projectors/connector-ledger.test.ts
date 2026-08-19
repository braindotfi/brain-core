import { describe, expect, it } from "vitest";
import { LEDGER_OBLIGATION_TYPES } from "@brain/shared";
import {
  projectBankStatementUploadLedger,
  projectCustomerAssertedCsvLedger,
  projectDocumentRecordsUploadLedger,
  projectFinchLedger,
  projectPlaidLedger,
  projectStripeLedger,
} from "./connector-ledger.js";
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

  it("projects bank statement uploads while preserving parser confidence", () => {
    const lowConfidence: ProjectionCommon = { ...common, confidence: 0.42 };
    const out = projectBankStatementUploadLedger(
      {
        object_type: "bank_statement",
        account: {
          account_id: "upload:raw_1:account",
          institution: "Mercury",
          name: "Operating",
          currency: "USD",
          current_balance: "1000",
        },
        transactions: [
          {
            transaction_id: "raw_1:bank:0001",
            date: "2026-06-01",
            description: "ACH CREDIT Acme Customer",
            amount: "2500",
            direction: "inflow",
            currency: "USD",
            counterparty_name: "Acme Customer",
          },
        ],
      },
      lowConfidence,
    );

    expect(out.map((p) => p.kind)).toEqual(["account", "counterparty", "transaction"]);
    expect(out[0]).toMatchObject({
      kind: "account",
      input: {
        sourceSystem: "document_upload",
        sourceNaturalKey: "upload:raw_1:account",
        common: { confidence: 0.42 },
      },
    });
    expect(out[2]).toMatchObject({
      kind: "transaction",
      input: {
        sourceNaturalKey: "raw_1:bank:0001",
        direction: "inflow",
        amount: "2500",
        common: { confidence: 0.42 },
      },
    });
  });

  it("normalizes uploaded bank counterparty names before creating identity keys", () => {
    const out = projectBankStatementUploadLedger(
      {
        object_type: "bank_statement",
        account: {
          account_id: "upload:raw_1:account",
          institution: "Mercury",
          name: "Operating",
          currency: "USD",
          current_balance: "1000",
        },
        transactions: [
          {
            transaction_id: "raw_1:bank:0001",
            date: "2026-06-01",
            description: "- GLOBEX CORP INV-1044",
            amount: "250",
            direction: "outflow",
            currency: "USD",
            counterparty_name: "- GLOBEX CORP INV-1044",
          },
          {
            transaction_id: "raw_1:bank:0002",
            date: "2026-06-02",
            description: "...",
            amount: "1",
            direction: "outflow",
            currency: "USD",
            counterparty_name: "...",
          },
        ],
      },
      common,
    );

    expect(out).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "counterparty",
          input: expect.objectContaining({
            sourceNaturalKey: "upload_counterparty:globex_corp",
            normalizedName: "globex_corp",
          }),
        }),
      ]),
    );
    expect(
      out.some(
        (op) => op.kind === "counterparty" && op.input.sourceNaturalKey === "upload_counterparty:",
      ),
    ).toBe(false);
  });

  it("projects AR aging upload rows into receivable obligations", () => {
    const out = projectDocumentRecordsUploadLedger(
      {
        object_type: "ar_aging",
        receivables: [
          {
            counterparty_name: "Acme Co",
            invoice_ref: "INV-100",
            amount: "1200.50",
            currency: "USD",
            aging_bucket: "31-60",
            due_date: "2026-07-15",
          },
        ],
      },
      { ...common, confidence: 0.88 },
    );

    expect(out.map((p) => p.kind)).toEqual(["counterparty", "obligation"]);
    expect(out[1]).toMatchObject({
      kind: "obligation",
      input: {
        sourceSystem: "document_upload",
        sourceNaturalKey: "ar:INV-100",
        direction: "receivable",
        type: "invoice",
        amount: "1200.50",
        common: { confidence: 0.88 },
      },
    });
  });

  it("projects payroll register upload rows into payroll obligations", () => {
    const out = projectDocumentRecordsUploadLedger(
      {
        object_type: "payroll_register",
        obligations: [
          {
            counterparty_name: "Payroll",
            run_ref: "RUN-2026-06-15",
            amount: "9000",
            net_amount: "9000",
            tax_amount: "2100",
            currency: "USD",
            due_date: "2026-06-15",
            cadence: "biweekly",
          },
        ],
      },
      { ...common, confidence: 0.81 },
    );

    expect(out.map((p) => p.kind)).toEqual(["counterparty", "obligation"]);
    expect(out[1]).toMatchObject({
      kind: "obligation",
      input: {
        sourceNaturalKey: "payroll:RUN-2026-06-15",
        direction: "payable",
        type: "payroll",
        amount: "9000",
        extensions: {
          document_upload: {
            net_amount: "9000",
            tax_amount: "2100",
            cadence: "biweekly",
          },
        },
      },
    });
  });

  // F2 vocabulary guard: every obligation `type` this file's projectors emit
  // must be a Ledger-recognized type (LEDGER_OBLIGATION_TYPES,
  // @brain/shared), because services/ledger/src/projection/obligations.ts
  // writes it verbatim into ledger_obligations.type, which is CHECK-
  // constrained. If a future projector introduces a new literal type without
  // widening the shared vocabulary + the ledger_obligations migration, this
  // test fails in CI instead of the projection worker hitting a 23514
  // check_violation in production.
  it("emits only Ledger-recognized obligation types", () => {
    const stripeDispute = projectStripeLedger(
      {
        object_type: "dispute",
        stripe_account_id: "acct_S1",
        objects: [{ id: "dp_1", amount: 125000, currency: "usd", status: "needs_response" }],
      },
      common,
    );
    const finchPayroll = projectFinchLedger(
      {
        object_type: "pay_run",
        objects: [{ id: "pay_1", pay_date: "2999-07-20", company_debit: { amount: 500000 } }],
      },
      common,
    );
    const arAging = projectDocumentRecordsUploadLedger(
      {
        object_type: "ar_aging",
        receivables: [
          {
            counterparty_name: "Acme Co",
            invoice_ref: "INV-100",
            amount: "1200.50",
            currency: "USD",
            aging_bucket: "31-60",
            due_date: "2026-07-15",
          },
        ],
      },
      common,
    );
    const payrollRegister = projectDocumentRecordsUploadLedger(
      {
        object_type: "payroll_register",
        obligations: [
          {
            counterparty_name: "Payroll",
            run_ref: "RUN-2026-06-15",
            amount: "9000",
            net_amount: "9000",
            tax_amount: "2100",
            currency: "USD",
            due_date: "2026-06-15",
            cadence: "biweekly",
          },
        ],
      },
      common,
    );

    const obligationTypes = [...stripeDispute, ...finchPayroll, ...arAging, ...payrollRegister]
      .map((p) => (p.kind === "obligation" ? p.input.type : null))
      .filter((t): t is string => t !== null);

    expect(obligationTypes.length).toBeGreaterThan(0);
    for (const type of obligationTypes) {
      expect(LEDGER_OBLIGATION_TYPES as readonly string[]).toContain(type);
    }
    // The specific F2 regression: Stripe disputes are a genuine 'dispute'
    // type, not silently flattened to 'other'.
    expect(obligationTypes).toContain("dispute");
  });

  it("skips payroll upload rows without a pay date", () => {
    const diag = { skippedRows: {} };
    const out = projectDocumentRecordsUploadLedger(
      {
        object_type: "payroll_register",
        obligations: [
          {
            counterparty_name: "Payroll",
            run_ref: "raw_1:payroll:3",
            amount: "67128.76",
            currency: "USD",
            due_date: null,
          },
        ],
      },
      common,
      diag,
    );

    expect(out).toEqual([]);
    expect(diag.skippedRows).toEqual({ payroll_register_obligation_missing_required_field: 1 });
  });

  it("projects declared payable and receivable CSV rows with explicit directions", () => {
    const payable = projectCustomerAssertedCsvLedger(
      {
        object_type: "customer_asserted_csv",
        record_type: "payables_invoices",
        records: [
          {
            invoice_id: "INV-VCS-2227",
            counterparty_id: "vnd_vertex_cloud",
            amount: "9150.00",
            currency: "USD",
            issued_date: "2026-07-01",
            due_date: "2026-07-31",
            status: "open",
          },
        ],
      },
      common,
    );
    const receivable = projectCustomerAssertedCsvLedger(
      {
        object_type: "customer_asserted_csv",
        record_type: "receivables_invoices",
        records: [
          {
            invoice_id: "AR-100",
            counterparty_id: "cus_orbit",
            amount: "12000.00",
            currency: "USD",
            issued_date: "2026-07-01",
            due_date: "2026-07-31",
            status: "open",
          },
        ],
      },
      common,
    );

    expect(payable).toEqual([
      expect.objectContaining({
        kind: "obligation",
        input: expect.objectContaining({
          sourceSystem: "customer_asserted_csv",
          sourceNaturalKey: "INV-VCS-2227",
          counterpartySourceKey: "vnd_vertex_cloud",
          direction: "payable",
          dueDate: "2026-07-31",
        }),
      }),
    ]);
    expect(receivable).toEqual([
      expect.objectContaining({
        kind: "obligation",
        input: expect.objectContaining({
          sourceNaturalKey: "AR-100",
          counterpartySourceKey: "cus_orbit",
          direction: "receivable",
        }),
      }),
    ]);
  });

  it("carries a vendor_name/customer_name extra column through as a counterparty name hint", () => {
    const withVendorName = projectCustomerAssertedCsvLedger(
      {
        object_type: "customer_asserted_csv",
        record_type: "payables_invoices",
        records: [
          {
            invoice_id: "INV-CMP-001",
            counterparty_id: "cp_new_001",
            amount: "48750.00",
            currency: "USD",
            issued_date: "2026-08-01",
            due_date: "2026-08-15",
            status: "pending",
            vendor_name: "Vantage Point Consulting",
          },
        ],
      },
      common,
    );
    const withoutHint = projectCustomerAssertedCsvLedger(
      {
        object_type: "customer_asserted_csv",
        record_type: "tax_obligations",
        records: [
          {
            obligation_id: "TAX-Q3-2026",
            counterparty_id: "tax_irs",
            amount: "58200.00",
            currency: "USD",
            due_date: "2026-09-15",
            status: "open",
          },
        ],
      },
      common,
    );

    expect(withVendorName).toEqual([
      expect.objectContaining({
        kind: "obligation",
        input: expect.objectContaining({
          extensions: expect.objectContaining({
            customer_asserted_csv: expect.objectContaining({
              counterparty_name_hint: "Vantage Point Consulting",
            }),
          }),
        }),
      }),
    ]);
    expect(withoutHint).toEqual([
      expect.objectContaining({
        kind: "obligation",
        input: expect.objectContaining({
          extensions: expect.objectContaining({
            customer_asserted_csv: expect.objectContaining({
              counterparty_name_hint: null,
            }),
          }),
        }),
      }),
    ]);
  });

  it("projects declared bank transaction CSV rows with the account and direction from the row", () => {
    const out = projectCustomerAssertedCsvLedger(
      {
        object_type: "customer_asserted_csv",
        record_type: "bank_transactions",
        records: [
          {
            transaction_id: "txn_9001",
            account_id: "acct_operations",
            date: "2026-07-01",
            description: "Wire to Acme Legal",
            amount: "4820.00",
            direction: "outflow",
            currency: "USD",
          },
        ],
      },
      common,
    );

    expect(out).toEqual([
      expect.objectContaining({
        kind: "transaction",
        input: expect.objectContaining({
          sourceSystem: "customer_asserted_csv",
          sourceNaturalKey: "txn_9001",
          accountSourceKey: "acct_operations",
          counterpartySourceKey: null,
          direction: "outflow",
          transactionDate: "2026-07-01",
          descriptionRaw: "Wire to Acme Legal",
        }),
      }),
    ]);
  });

  it("skips a bank transaction row with an invalid direction value", () => {
    const diag = { skippedRows: {} };
    const out = projectCustomerAssertedCsvLedger(
      {
        object_type: "customer_asserted_csv",
        record_type: "bank_transactions",
        records: [
          {
            transaction_id: "txn_9002",
            account_id: "acct_operations",
            date: "2026-07-01",
            description: "Unclear",
            amount: "100.00",
            direction: "sideways",
            currency: "USD",
          },
        ],
      },
      common,
      diag,
    );

    expect(out).toEqual([]);
    expect(diag.skippedRows).toEqual({
      customer_asserted_bank_transaction_missing_required_field: 1,
    });
  });

  it("never turns a counterparty first_seen field into a ledger obligation date", () => {
    const out = projectCustomerAssertedCsvLedger(
      {
        object_type: "customer_asserted_csv",
        record_type: "counterparties",
        records: [
          {
            counterparty_id: "vnd_vertex_cloud",
            name: "Vertex Cloud Systems",
            type: "vendor",
            first_seen: "2026-01-04",
          },
        ],
      },
      common,
    );

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: "counterparty",
      input: {
        sourceNaturalKey: "vnd_vertex_cloud",
        extensions: { customer_asserted_csv: { first_seen: "2026-01-04" } },
      },
    });
    expect(out.some((projection) => projection.kind === "obligation")).toBe(false);
  });

  it("retains an explicit bank transaction category code without inferring from its description", () => {
    const out = projectCustomerAssertedCsvLedger(
      {
        object_type: "customer_asserted_csv",
        record_type: "bank_transactions",
        records: [
          {
            transaction_id: "txn_cloud_1",
            account_id: "acct_operating",
            date: "2026-08-15",
            description: "Provider charge",
            amount: "1200.00",
            direction: "outflow",
            currency: "USD",
            category_code: "expense.cloud_infrastructure",
          },
        ],
      },
      common,
    );

    expect(out).toEqual([
      expect.objectContaining({
        kind: "transaction",
        input: expect.objectContaining({
          categoryAssignment: {
            canonicalCode: "expense.cloud_infrastructure",
            method: "source_provided",
            confidence: 1,
            sourceCategory: "expense.cloud_infrastructure",
          },
        }),
      }),
    ]);
  });

  it("rejects unsupported explicit bank transaction category codes", () => {
    expect(() =>
      projectCustomerAssertedCsvLedger(
        {
          object_type: "customer_asserted_csv",
          record_type: "bank_transactions",
          records: [
            {
              transaction_id: "txn_unknown_1",
              account_id: "acct_operating",
              date: "2026-08-15",
              description: "Unmapped",
              amount: "1200.00",
              direction: "outflow",
              currency: "USD",
              category_code: "expense.free_text_guess",
            },
          ],
        },
        common,
      ),
    ).toThrow("unsupported customer_asserted category_code");
  });

  it("retains tax authorities as named canonical counterparties", () => {
    const out = projectCustomerAssertedCsvLedger(
      {
        object_type: "customer_asserted_csv",
        record_type: "counterparties",
        records: [
          {
            counterparty_id: "tax_irs",
            name: "Internal Revenue Service",
            type: "tax_authority",
          },
        ],
      },
      common,
    );

    expect(out).toEqual([
      expect.objectContaining({
        kind: "counterparty",
        input: expect.objectContaining({
          sourceNaturalKey: "tax_irs",
          name: "Internal Revenue Service",
          type: "other",
          extensions: {
            customer_asserted_csv: expect.objectContaining({ declared_type: "tax_authority" }),
          },
        }),
      }),
    ]);
  });
});
