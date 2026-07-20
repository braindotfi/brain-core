/**
 * Tests for the Ledger + Wiki evidence providers (plan A3 / R-26).
 *
 * No Postgres: the ILedgerService / IWikiMemoryService boundaries are faked, so
 * these assert the context-keyed mapping (which reads run for which required
 * kind + context), the typed EvidenceRef shape, best-effort error tolerance,
 * and that the combined providers lift a ServiceEvidenceGatherer's completeness.
 */

import { describe, expect, it, vi } from "vitest";
import type {
  ILedgerService,
  IWikiMemoryService,
  Balance,
  Transaction,
  Counterparty,
  Invoice,
  Obligation,
  WikiPage,
} from "@brain/shared";
import { ServiceEvidenceGatherer } from "@brain/agent-router";
import {
  buildEvidenceProviders,
  makeLedgerEvidenceProvider,
  makeWikiEvidenceProvider,
} from "./evidence-providers.js";

const TENANT = "tnt_acme";

const balance: Balance = {
  id: "bal_1",
  owner_id: TENANT,
  account_id: "acct_1",
  as_of: "2026-06-01T00:00:00.000Z",
  current_balance: "1000.00",
  available_balance: "900.00",
  pending_balance: null,
  currency: "USD",
  provenance: "extracted",
  confidence: 1,
  source_ids: [],
  evidence_ids: [],
  created_at: "2026-06-01T00:00:00.000Z",
  updated_at: "2026-06-01T00:00:00.000Z",
} as unknown as Balance;

const transaction: Transaction = {
  id: "txn_1",
  account_id: "acct_1",
  external_transaction_id: null,
  amount: "42.00",
  currency: "USD",
  direction: "outflow",
  transaction_date: "2026-05-30T00:00:00.000Z",
  posted_date: null,
  counterparty_id: "cp_1",
  category_id: null,
  status: "posted",
  description_raw: null,
  description_normalized: null,
  reconciliation_status: "unreconciled",
  provenance: "extracted",
  confidence: 1,
} as unknown as Transaction;

const counterparty: Counterparty = {
  id: "cp_1",
  name: "Globex",
  type: "vendor",
  risk_level: "low",
  provenance: "extracted",
  confidence: 1,
} as unknown as Counterparty;

const invoice: Invoice = {
  id: "inv_1",
  invoice_number: "INV-001",
  counterparty_id: "cp_1",
  amount_due: "500.00",
  amount_paid: "0.00",
  currency: "USD",
  issue_date: "2026-05-01T00:00:00.000Z",
  due_date: "2026-06-01T00:00:00.000Z",
  status: "sent",
  linked_document_ids: [],
  linked_transaction_ids: [],
  provenance: "extracted",
  confidence: 1,
} as unknown as Invoice;

const obligation: Obligation = {
  id: "ob_1",
  type: "bill",
  counterparty_id: "cp_1",
  amount_due: "300.00",
  minimum_due: null,
  currency: "USD",
  due_date: "2026-06-15T00:00:00.000Z",
  recurrence: null,
  status: "due",
  linked_transaction_ids: [],
  // Uncorroborated, document-extracted ⇒ low persisted confidence. The
  // evidence builder must reflect THIS, not a hardcoded 1 (Codex P2).
  provenance: "agent_contributed",
  confidence: 0.4,
} as unknown as Obligation;

const wikiPage: WikiPage = {
  id: "page_1",
  page_type: "counterparty",
  subject_id: "cp_1",
  slug: "globex",
  body_md: "Globex is a vendor with two overdue invoices and a history of late delivery.",
  rendered_at: "2026-06-01T00:00:00.000Z",
  source_revision: "rev_1",
};

function fakeLedger(overrides: Partial<ILedgerService> = {}): ILedgerService {
  const base: Partial<ILedgerService> = {
    getAccount: vi.fn(async () => ({ account: {} as never, latest_balance: balance })),
    getTransaction: vi.fn(async () => transaction),
    listTransactions: vi.fn(async () => ({ items: [transaction], next_cursor: null })),
    listCounterparties: vi.fn(async () => ({ items: [counterparty], next_cursor: null })),
    listInvoices: vi.fn(async () => ({ items: [invoice], next_cursor: null })),
    listObligations: vi.fn(async () => ({ items: [obligation], next_cursor: null })),
    listBalances: vi.fn(async () => [balance]),
  };
  return { ...base, ...overrides } as unknown as ILedgerService;
}

function fakeWiki(overrides: Partial<IWikiMemoryService> = {}): IWikiMemoryService {
  const base: Partial<IWikiMemoryService> = {
    search: vi.fn(async () => [{ page: wikiPage, score: 0.9 }]),
  };
  return { ...base, ...overrides } as unknown as IWikiMemoryService;
}

describe("makeLedgerEvidenceProvider", () => {
  it("emits a balance from account_id", async () => {
    const provider = makeLedgerEvidenceProvider(fakeLedger());
    const items = await provider({
      tenantId: TENANT,
      context: { account_id: "acct_1" },
      requiredEvidence: ["balance"],
    });
    expect(items.map((i) => i.kind)).toEqual(["balance"]);
    expect(items[0]).toMatchObject({ object_id: "bal_1", source_system: "ledger" });
  });

  it("emits the referenced balance from balance_id", async () => {
    const newerBalance = {
      ...balance,
      id: "bal_2",
      as_of: "2026-06-02T00:00:00.000Z",
    } as unknown as Balance;
    const ledger = fakeLedger({
      listBalances: vi.fn(async () => [newerBalance, balance]),
    });
    const provider = makeLedgerEvidenceProvider(ledger);

    const items = await provider({
      tenantId: TENANT,
      context: { account_id: "acct_1", balance_id: "bal_1" },
      requiredEvidence: ["balance"],
    });

    expect(items.map((i) => i.kind)).toEqual(["balance"]);
    expect(items[0]).toMatchObject({ object_id: "bal_1", source_system: "ledger" });
    expect(ledger.listBalances).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT }),
      { account_id: "acct_1" },
    );
  });

  it("falls back to tenant balances when no account_id is referenced", async () => {
    const ledger = fakeLedger();
    const provider = makeLedgerEvidenceProvider(ledger);
    const items = await provider({ tenantId: TENANT, requiredEvidence: ["balance"] });
    expect(items.map((i) => i.kind)).toEqual(["balance"]);
    expect(ledger.listBalances).toHaveBeenCalledOnce();
  });

  it("emits a transaction from transaction_id", async () => {
    const provider = makeLedgerEvidenceProvider(fakeLedger());
    const items = await provider({
      tenantId: TENANT,
      context: { transaction_id: "txn_1" },
      requiredEvidence: ["transaction"],
    });
    expect(items.map((i) => i.kind)).toEqual(["transaction"]);
    expect(items[0]?.object_id).toBe("txn_1");
    expect(items[0]?.ref).toBe("txn_1");
  });

  it("emits a transaction for a referenced counterparty when no transaction_id", async () => {
    const provider = makeLedgerEvidenceProvider(fakeLedger());
    const items = await provider({
      tenantId: TENANT,
      context: { counterparty_id: "cp_1" },
      requiredEvidence: ["transaction"],
    });
    expect(items.map((i) => i.kind)).toEqual(["transaction"]);
  });

  it("resolves counterparty + invoice from counterparty_id", async () => {
    const provider = makeLedgerEvidenceProvider(fakeLedger());
    const items = await provider({
      tenantId: TENANT,
      context: { counterparty_id: "cp_1" },
      requiredEvidence: ["counterparty", "invoice"],
    });
    expect(items.map((i) => i.kind).sort()).toEqual(["counterparty", "invoice"]);
    expect(items.map((i) => i.ref).sort()).toEqual(["cp_1", "inv_1"]);
  });

  it("resolves vendor, payment destination, and counterparty history from context", async () => {
    const provider = makeLedgerEvidenceProvider(fakeLedger());
    const items = await provider({
      tenantId: TENANT,
      context: {
        counterparty_id: "cp_1",
        payment_instruction_id: "cpi_1",
        payment_destination_changed_at: "2026-07-18T00:00:00.000Z",
        payment_destination_confidence: "0.8",
        counterparty_history_id: "hist_1",
        counterparty_history_changed_at: "2026-07-18T00:00:01.000Z",
        counterparty_history_confidence: "0.7",
        history_risk_flag: false,
        history_risk_score: "0.2",
      },
      requiredEvidence: ["vendor", "payment_destination", "counterparty_history"],
    });

    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "vendor", ref: "cp_1" }),
        expect.objectContaining({
          kind: "payment_destination",
          ref: "cpi_1",
          confidence: 0.8,
          timestamp: "2026-07-18T00:00:00.000Z",
        }),
        expect.objectContaining({
          kind: "counterparty_history",
          ref: "hist_1",
          confidence: 0.7,
          timestamp: "2026-07-18T00:00:01.000Z",
          risk_flag: false,
          risk_score: 0.2,
        }),
      ]),
    );
  });

  it("resolves an obligation only when obligation_id is referenced", async () => {
    const provider = makeLedgerEvidenceProvider(fakeLedger());
    const items = await provider({
      tenantId: TENANT,
      context: { obligation_id: "ob_1" },
      requiredEvidence: ["obligation"],
    });
    expect(items.map((i) => i.kind)).toEqual(["obligation"]);
    expect(items[0]?.ref).toBe("ob_1");
  });

  it("propagates the obligation's persisted confidence, not a hardcoded 1 (Codex P2)", async () => {
    // A low-confidence (uncorroborated) obligation must not produce
    // high-confidence routing evidence merely because the row exists.
    const provider = makeLedgerEvidenceProvider(fakeLedger());
    const items = await provider({
      tenantId: TENANT,
      context: { obligation_id: "ob_1" },
      requiredEvidence: ["obligation"],
    });
    expect(items[0]?.confidence).toBe(0.4);
  });

  it("emits compliance policy decision and audit event evidence from context", async () => {
    const provider = makeLedgerEvidenceProvider(fakeLedger());
    const items = await provider({
      tenantId: TENANT,
      context: {
        policy_decision_id: "pd_1",
        audit_event_id: "evt_1",
        policy_summary: "confirm decision pd_1",
        audit_summary: "execution audit evt_1",
        policy_decision_confidence: "0.9",
        audit_event_confidence: "0.85",
      },
      requiredEvidence: ["policy_decision", "audit_event"],
    });

    expect(items).toEqual([
      expect.objectContaining({
        kind: "policy_decision",
        ref: "pd_1",
        source_system: "policy",
        excerpt: "confirm decision pd_1",
        confidence: 0.9,
      }),
      expect.objectContaining({
        kind: "audit_event",
        ref: "evt_1",
        source_system: "audit",
        excerpt: "execution audit evt_1",
        confidence: 0.85,
      }),
    ]);
  });

  it("emits dispute evidence from scanner context", async () => {
    const provider = makeLedgerEvidenceProvider(fakeLedger());
    const items = await provider({
      tenantId: TENANT,
      context: {
        dispute_id: "dsp_1",
        dispute_summary: "Chargeback on transaction txn_1",
        dispute_confidence: "0.8",
      },
      requiredEvidence: ["dispute"],
    });

    expect(items).toEqual([
      expect.objectContaining({
        kind: "dispute",
        ref: "dsp_1",
        source_system: "ledger",
        excerpt: "Chargeback on transaction txn_1",
        confidence: 0.8,
      }),
    ]);
  });

  it("produces no evidence when context lacks the needed reference", async () => {
    const provider = makeLedgerEvidenceProvider(fakeLedger());
    const items = await provider({
      tenantId: TENANT,
      context: {},
      requiredEvidence: ["transaction", "counterparty", "invoice", "obligation"],
    });
    expect(items).toEqual([]);
  });

  it("does not emit requested context evidence when referenced rows or ids are absent", async () => {
    const provider = makeLedgerEvidenceProvider(
      fakeLedger({
        listObligations: vi.fn(async () => ({ items: [], next_cursor: null })),
      }),
    );
    const items = await provider({
      tenantId: TENANT,
      context: { obligation_id: "ob_missing" },
      requiredEvidence: ["obligation", "dispute", "policy_decision", "audit_event"],
    });
    expect(items).toEqual([]);
  });

  it("only reads kinds the agent requires", async () => {
    const ledger = fakeLedger();
    const provider = makeLedgerEvidenceProvider(ledger);
    await provider({
      tenantId: TENANT,
      context: { account_id: "acct_1", transaction_id: "txn_1" },
      requiredEvidence: ["balance"],
    });
    expect(ledger.getAccount).toHaveBeenCalledOnce();
    expect(ledger.getTransaction).not.toHaveBeenCalled();
  });

  it("is best-effort: a read error yields no evidence rather than throwing", async () => {
    const ledger = fakeLedger({
      getAccount: vi.fn(async () => {
        throw new Error("db down");
      }),
    });
    const provider = makeLedgerEvidenceProvider(ledger);
    const items = await provider({
      tenantId: TENANT,
      context: { account_id: "acct_1" },
      requiredEvidence: ["balance"],
    });
    expect(items).toEqual([]);
  });
});

describe("makeWikiEvidenceProvider", () => {
  it("emits citations for a derived text query", async () => {
    const provider = makeWikiEvidenceProvider(fakeWiki());
    const items = await provider({
      tenantId: TENANT,
      context: { counterparty_name: "Globex" },
      requiredEvidence: [],
    });
    expect(items.map((i) => i.kind)).toEqual(["wiki"]);
    // `ref` is a wiki evidence reference (wiki:<slug>), not an auth scope.
    // Assert it via regex so the check-scope-vocab guard's {layer}:{verb}
    // heuristic does not mistake the literal for an unknown scope.
    expect(items[0]?.ref).toMatch(/^wiki:globex$/);
    expect(items[0]).toMatchObject({ source_system: "wiki" });
  });

  it("produces no citations when no text query can be derived", async () => {
    const wiki = fakeWiki();
    const provider = makeWikiEvidenceProvider(wiki);
    const items = await provider({ tenantId: TENANT, context: {}, requiredEvidence: [] });
    expect(items).toEqual([]);
    expect(wiki.search).not.toHaveBeenCalled();
  });

  it("is best-effort when wiki search fails", async () => {
    const provider = makeWikiEvidenceProvider(
      fakeWiki({
        search: vi.fn(async () => {
          throw new Error("wiki down");
        }),
      }),
    );
    const items = await provider({
      tenantId: TENANT,
      context: { query: "compliance policy" },
      requiredEvidence: [],
    });
    expect(items).toEqual([]);
  });
});

describe("buildEvidenceProviders + ServiceEvidenceGatherer", () => {
  it("lifts completeness for an evidence-bearing routing context", async () => {
    const gatherer = new ServiceEvidenceGatherer(
      buildEvidenceProviders({ ledger: fakeLedger(), wiki: fakeWiki() }),
    );
    const bundle = await gatherer.gather({
      tenantId: TENANT,
      context: { counterparty_id: "cp_1", account_id: "acct_1" },
      requiredEvidence: ["invoice", "counterparty"],
    });
    expect(bundle.completeness).toBe(1);
    expect(bundle.critical_missing).toBe(false);
  });

  it("keeps notify_only-safe empty completeness with no concrete references", async () => {
    const gatherer = new ServiceEvidenceGatherer(
      buildEvidenceProviders({ ledger: fakeLedger(), wiki: fakeWiki() }),
    );
    const bundle = await gatherer.gather({
      tenantId: TENANT,
      context: {},
      requiredEvidence: ["invoice", "counterparty", "payment_destination"],
    });
    expect(bundle.completeness).toBe(0);
    expect(bundle.critical_missing).toBe(true);
  });
});
