import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  decodeKeysetCursor,
  InMemoryAuditEmitter,
  isBrainError,
  newTenantId,
  newUserId,
} from "@brain/shared";
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
  calls: { text: string; values: unknown[] }[];
} {
  const log: string[] = [];
  const calls: { text: string; values: unknown[] }[] = [];
  const client = {
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      const summary = text.trim().split("\n")[0]!.trim();
      log.push(summary);
      calls.push({ text, values });
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
  return { pool, log, calls };
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

  it("serializes account provenance, confidence, source ids, and external account id", async () => {
    const { pool } = fakePool({
      "SELECT * FROM ledger_accounts": [
        {
          ...rowCommon(),
          id: "acct_provenance",
          institution: "Mercury",
          external_account_id: "plaid_account_123",
          account_type: "bank_checking",
          name: "Operating",
          currency: "USD",
          current_balance: "123.45",
          available_balance: "120.00",
          status: "active",
        },
      ],
    });
    const service = new LedgerService({ pool, audit: new InMemoryAuditEmitter() });
    const result = await service.getAccount(ctx, "acct_provenance");
    expect(result?.account).toMatchObject({
      id: "acct_provenance",
      provenance: "extracted",
      confidence: 0.9,
      source_ids: ["raw_abc"],
      external_account_id: "plaid_account_123",
    });
  });

  it("passes verified_status to the counterparty repository filter", async () => {
    const { pool, calls } = fakePool();
    const service = new LedgerService({ pool, audit: new InMemoryAuditEmitter() });
    await service.listCounterparties(ctx, { verified_status: "unverified" });
    const list = calls.find((c) => c.text.includes("SELECT * FROM ledger_counterparties"))!;
    expect(list.text).toContain("verified_status = $1");
    expect(list.values).toEqual(["unverified", 51]);
  });

  it("returns a keyset cursor when an account list has another page", async () => {
    const rows = [
      accountRow("acct_2", new Date("2026-07-02T00:00:00Z")),
      accountRow("acct_1", new Date("2026-07-01T00:00:00Z")),
    ];
    const { pool, calls } = fakePool({ "SELECT * FROM ledger_accounts": rows });
    const service = new LedgerService({ pool, audit: new InMemoryAuditEmitter() });
    const result = await service.listAccounts(ctx, { limit: 1 });
    expect(result.items.map((account) => account.id)).toEqual(["acct_2"]);
    expect(result.next_cursor).toEqual(expect.any(String));
    expect(decodeKeysetCursor(result.next_cursor!)).toEqual({
      sort: "2026-07-02T00:00:00.000Z",
      id: "acct_2",
    });
    const list = calls.find((c) => c.text.includes("SELECT * FROM ledger_accounts"))!;
    expect(list.values.at(-1)).toBe(2);
  });

  it("rejects malformed cursors before a list query runs", async () => {
    const { pool, calls } = fakePool();
    const service = new LedgerService({ pool, audit: new InMemoryAuditEmitter() });
    await expect(service.listTransactions(ctx, { cursor: "not-base64" })).rejects.toMatchObject({
      code: "invalid_cursor",
    });
    expect(calls.some((c) => c.text.includes("SELECT * FROM ledger_transactions"))).toBe(false);
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

function accountRow(id: string, createdAt: Date) {
  return {
    ...rowCommon(),
    id,
    created_at: createdAt,
    institution: "Mercury",
    external_account_id: id,
    account_type: "bank_checking",
    name: id,
    currency: "USD",
    current_balance: "1",
    available_balance: "1",
    status: "active",
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
      "INSERT INTO ledger_counterparties": [
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
          created: false,
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

  it("rejects an out-of-range confidence even for agent_contributed provenance", async () => {
    const { pool } = fakePool();
    const service = new LedgerService({ pool, audit: new InMemoryAuditEmitter() });
    await expect(
      service.upsertCounterparty(ctx, {
        name: "Whoever",
        type: "merchant",
        source_ids: [],
        evidence_ids: [],
        provenance: "agent_contributed",
        confidence: -0.5, // a negative confidence must not slip past the 0.5 cap
      }),
    ).rejects.toSatisfy((err) => isBrainError(err) && err.code === "ledger_row_invalid");
  });
});

describe("LedgerService manual counterparty endpoints", () => {
  it("creates a human confirmed vendor and emits vendor.created", async () => {
    const audit = new InMemoryAuditEmitter();
    const enqueue = vi.fn(async () => undefined);
    const { pool } = fakePool({
      "INSERT INTO ledger_counterparties": [
        {
          ...rowCommon(),
          id: "cp_manual",
          name: "Acme Trading LLC",
          normalized_name: "acme_trading_llc",
          type: "vendor",
          risk_level: null,
          verified_status: "unverified",
          aliases: ["Acme LLC", "Acme Trading"],
          linked_accounts: [],
          provenance: "human_confirmed",
          confidence: 0.95,
          metadata: { country: "AE", display_name: "Acme Trading" },
        },
      ],
    });
    const service = new LedgerService({ pool, audit, enqueue });
    const result = await service.createManualCounterparty(
      { ...ctx, principalType: "user", requestId: "req_manual" },
      {
        name: "Acme Trading LLC",
        type: "vendor",
        display_name: "Acme Trading",
        country: "AE",
        aliases: ["Acme LLC"],
      },
    );
    expect(result.created).toBe(true);
    expect(result.merged).toBe(false);
    expect(result.counterparty.provenance).toBe("human_confirmed");
    expect(result.counterparty.display_name).toBe("Acme Trading");
    expect(result.counterparty.aliases).toContain("Acme Trading");
    expect(result.counterparty.verified_status).toBe("unverified");
    expect(audit.events[0]!.action).toBe("ledger.counterparty.created");
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: ctx.tenantId,
        requestId: "req_manual",
        payload: expect.objectContaining({ event: "vendor.created" }),
      }),
    );
  });

  it("creates agent contributed rows for agent principals", async () => {
    const audit = new InMemoryAuditEmitter();
    const { pool, calls } = fakePool({
      "INSERT INTO ledger_counterparties": [
        {
          ...rowCommon(),
          id: "cp_agent_manual",
          name: "Agent Suggested Vendor",
          normalized_name: "agent_suggested_vendor",
          type: "vendor",
          risk_level: null,
          verified_status: "unverified",
          aliases: [],
          linked_accounts: [],
          provenance: "agent_contributed",
          confidence: 0.5,
          metadata: {},
        },
      ],
    });
    const service = new LedgerService({ pool, audit });
    const result = await service.createManualCounterparty(
      { ...ctx, principalType: "agent", actor: "agent_01ARZ3NDEKTSV4RRFFQ69G5FAV" },
      { name: "Agent Suggested Vendor", type: "vendor" },
    );
    expect(result.counterparty.provenance).toBe("agent_contributed");
    const insert = calls.find((c) => c.text.includes("INSERT INTO ledger_counterparties"))!;
    expect(insert.values[10]).toBe("agent_contributed");
    expect(insert.values[11]).toBe(0.5);
  });

  it("defaults display_name to name when metadata omits it", async () => {
    const audit = new InMemoryAuditEmitter();
    const { pool } = fakePool({
      "INSERT INTO ledger_counterparties": [
        {
          ...rowCommon(),
          id: "cp_default_display",
          name: "Default Display",
          normalized_name: "default_display",
          type: "vendor",
          risk_level: null,
          verified_status: "unverified",
          aliases: [],
          linked_accounts: [],
          provenance: "human_confirmed",
          confidence: 0.95,
          metadata: {},
        },
      ],
    });
    const service = new LedgerService({ pool, audit });
    const result = await service.createManualCounterparty(
      { ...ctx, principalType: "user" },
      { name: "Default Display", type: "vendor" },
    );
    expect(result.counterparty.display_name).toBe("Default Display");
  });

  it("does not downgrade trust state when manual create dedupes into an existing row", async () => {
    const audit = new InMemoryAuditEmitter();
    const { pool, calls } = fakePool({
      "INSERT INTO ledger_counterparties": [
        {
          ...rowCommon(),
          id: "cp_existing",
          name: "Acme",
          normalized_name: "acme",
          type: "vendor",
          risk_level: "low",
          verified_status: "sanctions_cleared",
          aliases: ["Acme LLC"],
          linked_accounts: [],
          metadata: {},
          created: false,
        },
      ],
    });
    const service = new LedgerService({ pool, audit });
    const result = await service.createManualCounterparty(
      { ...ctx, principalType: "user" },
      { name: "Acme", type: "vendor", aliases: ["Acme LLC"] },
    );
    expect(result.created).toBe(false);
    expect(result.counterparty.verified_status).toBe("sanctions_cleared");
    const insert = calls.find((c) => c.text.includes("INSERT INTO ledger_counterparties"))!;
    expect(insert.text).toContain("ON CONFLICT");
    expect(insert.values[6]).toBe("unverified");
    expect(insert.values[15]).toBe(false);
  });

  it("renames with the previous name preserved as an alias and audits changed fields", async () => {
    const audit = new InMemoryAuditEmitter();
    const { pool, calls } = fakePool({
      "WHERE id = $1 LIMIT 1": [
        {
          ...rowCommon(),
          id: "cp_existing",
          name: "Acme Old",
          normalized_name: "acme_old",
          type: "vendor",
          risk_level: null,
          verified_status: "unverified",
          aliases: ["AO"],
          linked_accounts: [],
          metadata: {},
        },
      ],
      "WHERE normalized_name = $1 AND type = $2": [],
      "UPDATE ledger_counterparties": [
        {
          ...rowCommon(),
          id: "cp_existing",
          name: "Acme New",
          normalized_name: "acme_new",
          type: "vendor",
          risk_level: null,
          verified_status: "unverified",
          aliases: ["AO", "Acme Old"],
          linked_accounts: [],
          provenance: "human_confirmed",
          metadata: { category: "logistics" },
        },
      ],
    });
    const service = new LedgerService({ pool, audit });
    const result = await service.updateCounterpartyIdentity(ctx, "cp_existing", {
      name: "Acme New",
      category: "logistics",
    });
    expect(result.counterparty.name).toBe("Acme New");
    expect(result.counterparty.aliases).toContain("Acme Old");
    expect(result.changed_fields).toEqual(["name", "aliases", "category"]);
    const update = calls.find((c) => c.text.includes("UPDATE ledger_counterparties"))!;
    expect(update.values).toContain("Acme New");
    expect(update.values.some((value) => Array.isArray(value) && value.includes("Acme Old"))).toBe(
      true,
    );
    expect(audit.events[0]!.action).toBe("ledger.counterparty.updated");
    expect(audit.events[0]!.inputs).toMatchObject({
      counterparty_id: "cp_existing",
      changed_fields: ["name", "aliases", "category"],
    });
  });

  it("updates display_name without rename collision and preserves the previous display name", async () => {
    const audit = new InMemoryAuditEmitter();
    const { pool, calls } = fakePool({
      "WHERE id = $1 LIMIT 1": [
        {
          ...rowCommon(),
          id: "cp_existing",
          name: "Acme Legal LLC",
          normalized_name: "acme_legal_llc",
          type: "vendor",
          risk_level: null,
          verified_status: "unverified",
          aliases: ["Acme"],
          linked_accounts: [],
          metadata: { display_name: "Acme Trading" },
        },
      ],
      "UPDATE ledger_counterparties": [
        {
          ...rowCommon(),
          id: "cp_existing",
          name: "Acme Legal LLC",
          normalized_name: "acme_legal_llc",
          type: "vendor",
          risk_level: null,
          verified_status: "unverified",
          aliases: ["Acme", "Acme Trading"],
          linked_accounts: [],
          provenance: "human_confirmed",
          metadata: { display_name: "Acme Supply" },
        },
      ],
    });
    const service = new LedgerService({ pool, audit });
    const result = await service.updateCounterpartyIdentity(ctx, "cp_existing", {
      display_name: "Acme Supply",
    });
    expect(result.counterparty.name).toBe("Acme Legal LLC");
    expect(result.counterparty.normalized_name).toBe("acme_legal_llc");
    expect(result.counterparty.display_name).toBe("Acme Supply");
    expect(result.counterparty.aliases).toContain("Acme Trading");
    expect(result.changed_fields).toEqual(["aliases", "display_name"]);
    expect(calls.some((c) => c.text.includes("WHERE normalized_name = $1 AND type = $2"))).toBe(
      false,
    );
  });

  it("returns name_conflict on rename collision without mutating", async () => {
    const { pool, calls } = fakePool({
      "WHERE id = $1 LIMIT 1": [
        {
          ...rowCommon(),
          id: "cp_existing",
          name: "Acme Old",
          normalized_name: "acme_old",
          type: "vendor",
          risk_level: null,
          verified_status: "unverified",
          aliases: [],
          linked_accounts: [],
          metadata: {},
        },
      ],
      "WHERE normalized_name = $1 AND type = $2": [
        {
          ...rowCommon(),
          id: "cp_other",
          name: "Acme New",
          normalized_name: "acme_new",
          type: "vendor",
          aliases: [],
          linked_accounts: [],
          metadata: {},
        },
      ],
    });
    const service = new LedgerService({ pool, audit: new InMemoryAuditEmitter() });
    await expect(
      service.updateCounterpartyIdentity(ctx, "cp_existing", { name: "Acme New" }),
    ).rejects.toSatisfy(
      (err) =>
        isBrainError(err) &&
        err.code === "ledger_reconciliation_conflict" &&
        err.details?.["reason"] === "name_conflict",
    );
    expect(calls.some((c) => c.text.includes("UPDATE ledger_counterparties"))).toBe(false);
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
    expect(result.created).toEqual([]);
    expect(audit.events.some((e) => e.action === "ledger.account.created")).toBe(false);
    expect(audit.events.some((e) => e.action === "ledger.transaction.posted")).toBe(false);
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
