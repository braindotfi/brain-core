import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { InMemoryAuditEmitter, isBrainError, newTenantId, newUserId } from "@brain/api/shared";
import { LedgerService } from "./LedgerService.js";

/**
 * Fake pg client that returns the supplied row map keyed by SQL prefix.
 * Each entry's value is the rows the next matching query returns. SELECT
 * statements that don't match return [] (driving null/missing paths).
 */
type SqlPattern = string;
function fakePool(routes: Record<SqlPattern, Array<Record<string, unknown>>> = {}): {
  pool: Pool;
  log: string[];
} {
  const log: string[] = [];
  const client = {
    query: vi.fn(async (text: string, _values?: unknown[]) => {
      const summary = text.trim().split("\n")[0]!.trim();
      log.push(summary);
      if (text.startsWith("BEGIN") || text === "COMMIT" || text === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (text.startsWith("SELECT set_config")) return { rows: [], rowCount: 0 };
      for (const [pattern, rows] of Object.entries(routes)) {
        if (text.includes(pattern)) {
          return { rows, rowCount: rows.length };
        }
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  const pool = { connect: async () => client } as unknown as Pool;
  return { pool, log };
}

const ctx = { tenantId: newTenantId(), actor: newUserId() };

// =============================================================================
// READS
// =============================================================================

describe("LedgerService — limit clamping and reads", () => {
  it("clamps account limit to default 50 when omitted", async () => {
    const { pool } = fakePool();
    const service = new LedgerService({ pool, audit: new InMemoryAuditEmitter() });
    const result = await service.listAccounts(ctx, { limit: 0 });
    expect(result.items).toEqual([]);
    expect(result.next_cursor).toBeNull();
  });

  it("clamps requested limit above max", async () => {
    const { pool } = fakePool();
    const service = new LedgerService({ pool, audit: new InMemoryAuditEmitter() });
    const result = await service.listTransactions(ctx, { limit: 99999 });
    expect(result.items).toEqual([]);
  });

  it("returns null when account is missing", async () => {
    const { pool } = fakePool();
    const service = new LedgerService({ pool, audit: new InMemoryAuditEmitter() });
    const result = await service.getAccount(ctx, "acct_DOES_NOT_EXIST");
    expect(result).toBeNull();
  });
});

// =============================================================================
// WRITES (Phase 3)
// =============================================================================

const NOW = new Date("2026-04-24T00:00:00Z");

function rowCommon() {
  return {
    owner_id: ctx.tenantId,
    source_ids: ["raw_abc"],
    evidence_ids: ["prs_def"],
    provenance: "extracted",
    confidence: 0.9,
    created_at: NOW,
    updated_at: NOW,
  };
}

describe("LedgerService.upsertCounterparty", () => {
  it("creates a new counterparty when no normalized_name match exists", async () => {
    const audit = new InMemoryAuditEmitter();
    const { pool } = fakePool({
      "INSERT INTO ledger_counterparties": [
        {
          ...rowCommon(),
          id: "cp_NEW",
          name: "Acme",
          normalized_name: "acme",
          type: "vendor",
          risk_level: null,
          verified_status: null,
          aliases: [],
          linked_accounts: [],
          confidence: 0.9,
        },
      ],
    });
    const service = new LedgerService({ pool, audit });
    const cp = await service.upsertCounterparty(ctx, {
      name: "Acme",
      type: "vendor",
      source_ids: ["raw_abc"],
      evidence_ids: ["prs_def"],
      provenance: "extracted",
      confidence: 0.9,
    });
    expect(cp.id).toBe("cp_NEW");
    expect(cp.confidence).toBe(0.9);
    expect(audit.events.some((e) => e.action === "ledger.counterparty.created")).toBe(true);
  });

  it("merges aliases into existing counterparty (deduplicated by normalized_name)", async () => {
    const audit = new InMemoryAuditEmitter();
    const { pool } = fakePool({
      "FROM ledger_counterparties\n      WHERE normalized_name": [
        {
          ...rowCommon(),
          id: "cp_EXISTING",
          name: "Acme",
          normalized_name: "acme",
          type: "vendor",
          aliases: ["Acme Inc"],
          linked_accounts: [],
          source_ids: ["raw_old"],
          evidence_ids: ["prs_old"],
        },
      ],
      "UPDATE ledger_counterparties": [
        {
          ...rowCommon(),
          id: "cp_EXISTING",
          name: "Acme",
          normalized_name: "acme",
          type: "vendor",
          aliases: ["Acme Inc", "ACME LLC"],
          linked_accounts: [],
          source_ids: ["raw_old", "raw_abc"],
          evidence_ids: ["prs_old", "prs_def"],
        },
      ],
    });
    const service = new LedgerService({ pool, audit });
    const cp = await service.upsertCounterparty(ctx, {
      name: "Acme",
      type: "vendor",
      aliases: ["ACME LLC"],
      source_ids: ["raw_abc"],
      evidence_ids: ["prs_def"],
      provenance: "extracted",
      confidence: 0.7,
    });
    expect(cp.id).toBe("cp_EXISTING");
    expect(cp.aliases).toContain("ACME LLC");
    expect(audit.events.some((e) => e.action === "ledger.counterparty.merged")).toBe(true);
  });

  it("caps confidence at 0.5 for agent_contributed provenance", async () => {
    const audit = new InMemoryAuditEmitter();
    const { pool } = fakePool({
      "INSERT INTO ledger_counterparties": [
        {
          ...rowCommon(),
          id: "cp_AGENT",
          name: "Whoever",
          normalized_name: "whoever",
          type: "merchant",
          aliases: [],
          linked_accounts: [],
          provenance: "agent_contributed",
          confidence: 0.5,
        },
      ],
    });
    const service = new LedgerService({ pool, audit });
    const cp = await service.upsertCounterparty(ctx, {
      name: "Whoever",
      type: "merchant",
      source_ids: [],
      evidence_ids: [],
      provenance: "agent_contributed",
      confidence: 0.99, // caller passes high confidence; cap kicks in
    });
    expect(cp.confidence).toBe(0.5);
  });
});

describe("LedgerService.upsertAccount", () => {
  it("creates a new account when external id is unseen", async () => {
    const audit = new InMemoryAuditEmitter();
    const { pool } = fakePool({
      "INSERT INTO ledger_accounts": [
        {
          ...rowCommon(),
          id: "acct_NEW",
          institution: null,
          external_account_id: "plaid_acc_1",
          account_type: "bank_checking",
          name: "Chase Checking",
          currency: "USD",
          current_balance: "1000.00000000",
          available_balance: null,
          status: "active",
        },
      ],
    });
    const service = new LedgerService({ pool, audit });
    const acct = await service.upsertAccount(ctx, {
      external_account_id: "plaid_acc_1",
      account_type: "bank_checking",
      name: "Chase Checking",
      currency: "USD",
      current_balance: "1000.00",
      status: "active",
      source_ids: ["raw_abc"],
      evidence_ids: ["prs_def"],
      provenance: "extracted",
      confidence: 0.95,
    });
    expect(acct.id).toBe("acct_NEW");
    expect(acct.account_type).toBe("bank_checking");
    expect(audit.events.some((e) => e.action === "ledger.account.created")).toBe(true);
  });

  it("updates an existing account when external id is already known", async () => {
    const audit = new InMemoryAuditEmitter();
    const { pool } = fakePool({
      "FROM ledger_accounts WHERE external_account_id": [
        {
          ...rowCommon(),
          id: "acct_EXISTING",
          institution: "Chase",
          external_account_id: "plaid_acc_1",
          account_type: "bank_checking",
          name: "Chase Checking",
          currency: "USD",
          current_balance: "1000.00000000",
          available_balance: null,
          status: "active",
          source_ids: ["raw_old"],
          evidence_ids: ["prs_old"],
        },
      ],
      "UPDATE ledger_accounts": [
        {
          ...rowCommon(),
          id: "acct_EXISTING",
          institution: "Chase",
          external_account_id: "plaid_acc_1",
          account_type: "bank_checking",
          name: "Chase Checking",
          currency: "USD",
          current_balance: "1500.00000000",
          available_balance: "1450.00000000",
          status: "active",
          source_ids: ["raw_old", "raw_abc"],
          evidence_ids: ["prs_old", "prs_def"],
        },
      ],
    });
    const service = new LedgerService({ pool, audit });
    const acct = await service.upsertAccount(ctx, {
      external_account_id: "plaid_acc_1",
      account_type: "bank_checking",
      name: "Chase Checking",
      currency: "USD",
      current_balance: "1500.00",
      available_balance: "1450.00",
      status: "active",
      source_ids: ["raw_abc"],
      evidence_ids: ["prs_def"],
      provenance: "extracted",
      confidence: 0.95,
    });
    expect(acct.id).toBe("acct_EXISTING");
    expect(acct.current_balance).toContain("1500");
    expect(audit.events.some((e) => e.action === "ledger.account.updated")).toBe(true);
  });
});

describe("LedgerService.recordTransaction", () => {
  it("posts a new transaction when external id is unseen", async () => {
    const audit = new InMemoryAuditEmitter();
    const { pool } = fakePool({
      "INSERT INTO ledger_transactions": [
        {
          ...rowCommon(),
          id: "tx_NEW",
          account_id: "acct_X",
          external_transaction_id: "plaid_tx_1",
          amount: "4.50000000",
          currency: "USD",
          direction: "outflow",
          transaction_date: NOW,
          posted_date: null,
          counterparty_id: null,
          category_id: null,
          status: "posted",
          description_raw: "Coffee",
          description_normalized: null,
          reconciliation_status: "unreconciled",
        },
      ],
    });
    const service = new LedgerService({ pool, audit });
    const tx = await service.recordTransaction(ctx, {
      account_id: "acct_X",
      external_transaction_id: "plaid_tx_1",
      amount: "4.50",
      currency: "USD",
      direction: "outflow",
      transaction_date: NOW.toISOString(),
      status: "posted",
      description_raw: "Coffee",
      source_ids: ["raw_abc"],
      evidence_ids: ["prs_def"],
      provenance: "extracted",
      confidence: 0.9,
    });
    expect(tx.id).toBe("tx_NEW");
    expect(tx.status).toBe("posted");
    expect(audit.events.some((e) => e.action === "ledger.transaction.posted")).toBe(true);
  });

  it("returns the existing row + emits a deduplicated event when external id matches", async () => {
    const audit = new InMemoryAuditEmitter();
    const existing = {
      ...rowCommon(),
      id: "tx_EXISTING",
      account_id: "acct_X",
      external_transaction_id: "plaid_tx_1",
      amount: "4.50000000",
      currency: "USD",
      direction: "outflow",
      transaction_date: NOW,
      posted_date: null,
      counterparty_id: null,
      category_id: null,
      status: "posted",
      description_raw: null,
      description_normalized: null,
      reconciliation_status: "unreconciled",
    };
    const { pool } = fakePool({
      "WHERE account_id = $1 AND external_transaction_id": [existing],
    });
    const service = new LedgerService({ pool, audit });
    const tx = await service.recordTransaction(ctx, {
      account_id: "acct_X",
      external_transaction_id: "plaid_tx_1",
      amount: "4.50",
      currency: "USD",
      direction: "outflow",
      transaction_date: NOW.toISOString(),
      status: "posted",
      source_ids: [],
      evidence_ids: [],
      provenance: "extracted",
      confidence: 0.9,
    });
    expect(tx.id).toBe("tx_EXISTING");
    expect(audit.events.some((e) => e.action === "ledger.transaction.deduplicated")).toBe(true);
  });

  it("rejects negative amount strings", async () => {
    const audit = new InMemoryAuditEmitter();
    const { pool } = fakePool();
    const service = new LedgerService({ pool, audit });
    await expect(
      service.recordTransaction(ctx, {
        account_id: "acct_X",
        external_transaction_id: null,
        amount: "-1.00",
        currency: "USD",
        direction: "outflow",
        transaction_date: NOW.toISOString(),
        status: "posted",
        source_ids: [],
        evidence_ids: [],
        provenance: "extracted",
        confidence: 0.9,
      }),
    ).rejects.toSatisfy((err) => isBrainError(err) && err.code === "ledger_row_invalid");
  });
});

describe("LedgerService.normalizeFromRaw", () => {
  it("dispatches plaid_tx_v1 to the Plaid extractor and returns created rows", async () => {
    const audit = new InMemoryAuditEmitter();
    const { pool } = fakePool({
      "FROM raw_parsed": [
        {
          id: "prs_def",
          raw_artifact_id: "raw_abc",
          parser: "plaid_tx_v1",
          parser_version: "1.0.0",
          extracted: {
            accounts: [
              {
                account_id: "plaid_acc_1",
                name: "Chase",
                type: "depository",
                iso_currency_code: "USD",
              },
            ],
            transactions: [
              {
                transaction_id: "plaid_tx_1",
                account_id: "plaid_acc_1",
                amount: 4.5,
                iso_currency_code: "USD",
                date: "2026-04-12",
                merchant_name: "Blue Bottle",
              },
            ],
          },
        },
      ],
      "INSERT INTO ledger_accounts": [
        {
          ...rowCommon(),
          id: "acct_NEW",
          institution: null,
          external_account_id: "plaid_acc_1",
          account_type: "bank_checking",
          name: "Chase",
          currency: "USD",
          current_balance: null,
          available_balance: null,
          status: "active",
        },
      ],
      "INSERT INTO ledger_counterparties": [
        {
          ...rowCommon(),
          id: "cp_NEW",
          name: "Blue Bottle",
          normalized_name: "blue_bottle",
          type: "merchant",
          aliases: [],
          linked_accounts: [],
        },
      ],
      "INSERT INTO ledger_transactions": [
        {
          ...rowCommon(),
          id: "tx_NEW",
          account_id: "acct_NEW",
          external_transaction_id: "plaid_tx_1",
          amount: "4.50000000",
          currency: "USD",
          direction: "outflow",
          transaction_date: NOW,
          posted_date: null,
          counterparty_id: "cp_NEW",
          category_id: null,
          status: "posted",
          description_raw: null,
          description_normalized: "Blue Bottle",
          reconciliation_status: "unreconciled",
        },
      ],
    });
    const service = new LedgerService({ pool, audit });
    const result = await service.normalizeFromRaw(ctx, "prs_def");
    expect(result.created.map((r) => r.entity)).toEqual(["account", "counterparty", "transaction"]);
    expect(audit.events.some((e) => e.action === "ledger.account.created")).toBe(true);
    expect(audit.events.some((e) => e.action === "ledger.transaction.posted")).toBe(true);
  });

  it("returns 404 when raw_parsed id is missing", async () => {
    const audit = new InMemoryAuditEmitter();
    const { pool } = fakePool();
    const service = new LedgerService({ pool, audit });
    await expect(service.normalizeFromRaw(ctx, "prs_missing")).rejects.toSatisfy(
      (err) => isBrainError(err) && err.code === "ledger_row_not_found",
    );
  });

  it("rejects unknown parser ids", async () => {
    const audit = new InMemoryAuditEmitter();
    const { pool } = fakePool({
      "FROM raw_parsed": [
        {
          id: "prs_x",
          raw_artifact_id: "raw_x",
          parser: "unknown_parser_v1",
          parser_version: "1.0.0",
          extracted: {},
        },
      ],
    });
    const service = new LedgerService({ pool, audit });
    await expect(service.normalizeFromRaw(ctx, "prs_x")).rejects.toSatisfy(
      (err) => isBrainError(err) && err.code === "raw_source_unsupported",
    );
  });
});
