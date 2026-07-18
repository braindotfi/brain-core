import { describe, expect, it } from "vitest";
import {
  newAccountId,
  newCounterpartyId,
  newInvoiceId,
  newObligationId,
  newTenantId,
  newTransactionId,
  newUserId,
  newWikiEntityId,
  type ServiceCallContext,
} from "@brain/shared";
import type { Pool } from "pg";
import {
  isEvidenceKindResolvable,
  parseEvidenceResolveBody,
  resolveEvidenceRefs,
  unsupportedEvidenceKinds,
} from "./resolve.js";

const TENANT = newTenantId();
const ctx: ServiceCallContext = { tenantId: TENANT, actor: newUserId() };

const accountId = newAccountId();
const counterpartyId = newCounterpartyId();
const invoiceId = newInvoiceId();
const obligationId = newObligationId();
const transactionId = newTransactionId();
const wikiEntityId = newWikiEntityId();

describe("resolveEvidenceRefs", () => {
  it("resolves every supported kind into a summary and deep link", async () => {
    const results = await resolveEvidenceRefs(fakePool(), ctx, [
      { kind: "account", ref: accountId },
      { kind: "counterparty", ref: counterpartyId },
      { kind: "invoice", ref: invoiceId },
      { kind: "obligation", ref: obligationId },
      { kind: "transaction", ref: transactionId },
      { kind: "wiki_entity", ref: wikiEntityId },
    ]);

    expect(results).toEqual([
      {
        kind: "account",
        ref: accountId,
        resolvable: true,
        not_found: false,
        summary: "Operating USD bank_checking (active)",
        deep_link: `/ledger/accounts/${accountId}`,
      },
      {
        kind: "counterparty",
        ref: counterpartyId,
        resolvable: true,
        not_found: false,
        summary: "Acme (vendor)",
        deep_link: `/ledger/counterparties/${counterpartyId}`,
      },
      {
        kind: "invoice",
        ref: invoiceId,
        resolvable: true,
        not_found: false,
        summary: "Invoice INV-7: 70.00 USD (sent)",
        deep_link: `/ledger/invoices/${invoiceId}`,
      },
      {
        kind: "obligation",
        ref: obligationId,
        resolvable: true,
        not_found: false,
        summary: "invoice 70.00 USD due 2026-01-31 (open)",
        deep_link: `/ledger/obligations/${obligationId}/resolved`,
      },
      {
        kind: "transaction",
        ref: transactionId,
        resolvable: true,
        not_found: false,
        summary: "outflow 70.00 USD: Acme payment",
        deep_link: `/ledger/transactions/${transactionId}`,
      },
      {
        kind: "wiki_entity",
        ref: wikiEntityId,
        resolvable: true,
        not_found: false,
        summary: "Wiki policy: Evidence Policy",
        deep_link: `/wiki/entity/${wikiEntityId}`,
      },
    ]);
  });

  it("returns honest unsupported, malformed, and not found results", async () => {
    await expect(
      resolveEvidenceRefs(fakePool(), ctx, [
        { kind: "document", ref: "doc_01H00000000000000000000000" },
        { kind: "account", ref: "cp_01H00000000000000000000000" },
        { kind: "invoice", ref: newInvoiceId() },
      ]),
    ).resolves.toEqual([
      {
        kind: "document",
        ref: "doc_01H00000000000000000000000",
        resolvable: false,
        not_found: false,
        summary: null,
        deep_link: null,
        reason: "unsupported_kind",
      },
      {
        kind: "account",
        ref: "cp_01H00000000000000000000000",
        resolvable: false,
        not_found: false,
        summary: null,
        deep_link: null,
        reason: "malformed_ref",
      },
      {
        kind: "invoice",
        ref: expect.stringMatching(/^inv_/),
        resolvable: true,
        not_found: true,
        summary: null,
        deep_link: null,
      },
    ]);
  });

  it("parses request bodies and reports resolver capabilities", () => {
    expect(
      parseEvidenceResolveBody({
        refs: [{ kind: " counterparty ", ref: ` ${counterpartyId} ` }],
      }),
    ).toEqual([{ kind: "counterparty", ref: counterpartyId }]);
    expect(isEvidenceKindResolvable("counterparty")).toBe(true);
    expect(isEvidenceKindResolvable("document")).toBe(false);
    expect(
      unsupportedEvidenceKinds([
        { kind: "document", ref: "doc_1" },
        { kind: "raw_parsed", ref: "prs_1" },
        { kind: "document", ref: "doc_2" },
        { kind: "account", ref: accountId },
      ]),
    ).toEqual(["document", "raw_parsed"]);
    expect(() => parseEvidenceResolveBody({ refs: "bad" })).toThrow(/refs must be an array/);
    expect(() => parseEvidenceResolveBody({ refs: [null] })).toThrow(/refs\[0\] must be an object/);
    expect(() => parseEvidenceResolveBody({ refs: [{ kind: "", ref: accountId }] })).toThrow(
      /kind must be a non-empty string/,
    );
    expect(() => parseEvidenceResolveBody({ refs: [{ kind: "account", ref: "" }] })).toThrow(
      /ref must be a non-empty string/,
    );
  });
});

function fakePool(): Pool {
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (sql.startsWith("SELECT set_config")) {
        return { rows: [], rowCount: 0 };
      }
      const id = values[0];
      if (sql.includes("FROM ledger_accounts") && id === accountId) {
        return { rows: [accountRow()], rowCount: 1 };
      }
      if (sql.includes("FROM ledger_counterparties") && id === counterpartyId) {
        return { rows: [counterpartyRow()], rowCount: 1 };
      }
      if (sql.includes("FROM ledger_invoices") && id === invoiceId) {
        return { rows: [invoiceRow()], rowCount: 1 };
      }
      if (sql.includes("FROM ledger_obligations") && id === obligationId) {
        return { rows: [obligationRow()], rowCount: 1 };
      }
      if (sql.includes("FROM ledger_transactions") && id === transactionId) {
        return { rows: [transactionRow()], rowCount: 1 };
      }
      if (sql.includes("FROM wiki_entities") && id === wikiEntityId) {
        return {
          rows: [{ id: wikiEntityId, kind: "policy", attributes: { name: "Evidence Policy" } }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  return { connect: async () => client } as unknown as Pool;
}

function common(id: string) {
  return {
    id,
    owner_id: TENANT,
    source_ids: [],
    evidence_ids: [],
    provenance: "human_confirmed",
    confidence: 1,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    updated_at: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function accountRow() {
  return {
    ...common(accountId),
    institution: null,
    external_account_id: null,
    account_type: "bank_checking",
    name: "Operating",
    currency: "USD",
    current_balance: null,
    available_balance: null,
    status: "active",
  };
}

function counterpartyRow() {
  return {
    ...common(counterpartyId),
    name: "Acme",
    normalized_name: "acme",
    type: "vendor",
    risk_level: null,
    verified_status: "unverified",
    aliases: [],
    linked_accounts: [],
    agent_id: null,
    onchain_address: null,
    metadata: {},
  };
}

function invoiceRow() {
  return {
    ...common(invoiceId),
    invoice_number: "INV-7",
    counterparty_id: counterpartyId,
    amount_due: "70.00",
    amount_paid: "0.00",
    currency: "USD",
    issue_date: new Date("2026-01-01T00:00:00.000Z"),
    due_date: new Date("2026-01-31T00:00:00.000Z"),
    status: "sent",
    linked_document_ids: [],
    linked_transaction_ids: [],
    metadata: {},
  };
}

function obligationRow() {
  return {
    ...common(obligationId),
    type: "invoice",
    counterparty_id: counterpartyId,
    amount_due: "70.00",
    minimum_due: null,
    currency: "USD",
    due_date: new Date("2026-01-31T00:00:00.000Z"),
    recurrence: null,
    status: "open",
    external_key: null,
    linked_transaction_ids: [],
    direction: "payable",
  };
}

function transactionRow() {
  return {
    ...common(transactionId),
    account_id: accountId,
    external_transaction_id: null,
    amount: "70.00",
    currency: "USD",
    direction: "outflow",
    transaction_date: new Date("2026-01-15T00:00:00.000Z"),
    posted_date: null,
    counterparty_id: counterpartyId,
    category_id: null,
    status: "posted",
    description_raw: null,
    description_normalized: "Acme payment",
    reconciliation_status: null,
    chain_tx_hash: null,
  };
}
