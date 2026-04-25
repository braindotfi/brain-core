/**
 * LedgerService — Phase-2 implementation.
 *
 * Implements the read side of `ILedgerService` from
 * `@brain/api/shared/contracts`. Writes (upsertAccount, recordTransaction,
 * upsertCounterparty, normalizeFromRaw) are stubbed for Phase 2 and throw
 * an explicit "not implemented in this phase" error so callers fail
 * loudly rather than silently producing the wrong data path.
 *
 * Phase 3 implements writes and rewrites the Plaid extractor to call
 * recordTransaction instead of writing wiki entities.
 */

import {
  brainError,
  withTenantScope,
  type ILedgerService,
  type ServiceCallContext,
  type Account,
  type AccountListFilters,
  type Balance,
  type Counterparty,
  type Document,
  type Invoice,
  type ListResult,
  type Obligation,
  type ObligationListFilters,
  type Transaction,
  type TransactionListFilters,
  type RecordTransactionInput,
  type UpsertAccountInput,
  type UpsertCounterpartyInput,
} from "@brain/api/shared";
import {
  findAccountById,
  findCounterpartyById,
  findDocumentById,
  findInvoiceById,
  findObligationById,
  findTransactionById,
  findLatestBalance,
  listAccounts as listAccountsRepo,
  listBalances as listBalancesRepo,
  listCounterparties as listCounterpartiesRepo,
  listDocuments as listDocumentsRepo,
  listInvoices as listInvoicesRepo,
  listObligations as listObligationsRepo,
  listTransactions as listTransactionsRepo,
  type AccountRow,
  type BalanceRow,
  type CounterpartyRow,
  type DocumentRow,
  type InvoiceRow,
  type ObligationRow,
  type TransactionRow,
} from "../repository/index.js";
import type { LedgerDeps } from "../deps.js";

export class LedgerService implements ILedgerService {
  public constructor(private readonly deps: LedgerDeps) {}

  // ----- Reads -----------------------------------------------------------

  public async listAccounts(ctx: ServiceCallContext, f: AccountListFilters): Promise<ListResult<Account>> {
    const limit = clampLimit(f.limit, 50, 500);
    const rows = await withTenantScope(this.deps.pool, ctx.tenantId, (c) =>
      listAccountsRepo(c, {
        ...(f.status !== undefined ? { status: f.status } : {}),
        ...(f.account_type !== undefined ? { account_type: f.account_type } : {}),
        limit,
      }),
    );
    return { items: rows.map(serializeAccount), next_cursor: null };
  }

  public async getAccount(
    ctx: ServiceCallContext,
    id: string,
  ): Promise<{ account: Account; latest_balance: Balance | null } | null> {
    const result = await withTenantScope(this.deps.pool, ctx.tenantId, async (c) => {
      const acct = await findAccountById(c, id);
      if (acct === null) return null;
      const latest = await findLatestBalance(c, id);
      return { acct, latest };
    });
    if (result === null) return null;
    return {
      account: serializeAccount(result.acct),
      latest_balance: result.latest === null ? null : serializeBalance(result.latest),
    };
  }

  public async listTransactions(
    ctx: ServiceCallContext,
    f: TransactionListFilters,
  ): Promise<ListResult<Transaction>> {
    const limit = clampLimit(f.limit, 100, 1000);
    const rows = await withTenantScope(this.deps.pool, ctx.tenantId, (c) =>
      listTransactionsRepo(c, {
        ...(f.account_id !== undefined ? { account_id: f.account_id } : {}),
        ...(f.counterparty_id !== undefined ? { counterparty_id: f.counterparty_id } : {}),
        ...(f.direction !== undefined ? { direction: f.direction } : {}),
        ...(f.status !== undefined ? { status: f.status } : {}),
        ...(f.since !== undefined ? { since: new Date(f.since) } : {}),
        ...(f.until !== undefined ? { until: new Date(f.until) } : {}),
        limit,
      }),
    );
    return { items: rows.map(serializeTransaction), next_cursor: null };
  }

  public async getTransaction(ctx: ServiceCallContext, id: string): Promise<Transaction | null> {
    const row = await withTenantScope(this.deps.pool, ctx.tenantId, (c) => findTransactionById(c, id));
    return row === null ? null : serializeTransaction(row);
  }

  public async listCounterparties(
    ctx: ServiceCallContext,
    f: { q?: string; type?: Counterparty["type"]; limit?: number },
  ): Promise<ListResult<Counterparty>> {
    const limit = clampLimit(f.limit, 50, 500);
    const rows = await withTenantScope(this.deps.pool, ctx.tenantId, (c) =>
      listCounterpartiesRepo(c, {
        ...(f.q !== undefined ? { q: f.q } : {}),
        ...(f.type !== undefined ? { type: f.type } : {}),
        limit,
      }),
    );
    return { items: rows.map(serializeCounterparty), next_cursor: null };
  }

  public async listObligations(
    ctx: ServiceCallContext,
    f: ObligationListFilters,
  ): Promise<ListResult<Obligation>> {
    const limit = clampLimit(f.limit, 50, 500);
    const rows = await withTenantScope(this.deps.pool, ctx.tenantId, (c) =>
      listObligationsRepo(c, {
        ...(f.status !== undefined ? { status: f.status } : {}),
        ...(f.type !== undefined ? { type: f.type } : {}),
        ...(f.due_before !== undefined ? { due_before: new Date(f.due_before) } : {}),
        limit,
      }),
    );
    return { items: rows.map(serializeObligation), next_cursor: null };
  }

  public async listInvoices(
    ctx: ServiceCallContext,
    f: { status?: Invoice["status"]; counterparty_id?: string; limit?: number },
  ): Promise<ListResult<Invoice>> {
    const limit = clampLimit(f.limit, 50, 500);
    const rows = await withTenantScope(this.deps.pool, ctx.tenantId, (c) =>
      listInvoicesRepo(c, {
        ...(f.status !== undefined ? { status: f.status } : {}),
        ...(f.counterparty_id !== undefined ? { counterparty_id: f.counterparty_id } : {}),
        limit,
      }),
    );
    return { items: rows.map(serializeInvoice), next_cursor: null };
  }

  public async listDocuments(
    ctx: ServiceCallContext,
    f: { document_type?: Document["document_type"]; limit?: number },
  ): Promise<ListResult<Document>> {
    const limit = clampLimit(f.limit, 50, 500);
    const rows = await withTenantScope(this.deps.pool, ctx.tenantId, (c) =>
      listDocumentsRepo(c, {
        ...(f.document_type !== undefined ? { document_type: f.document_type } : {}),
        limit,
      }),
    );
    return { items: rows.map(serializeDocument), next_cursor: null };
  }

  public async listBalances(
    ctx: ServiceCallContext,
    f: { account_id?: string; as_of?: string },
  ): Promise<Balance[]> {
    const rows = await withTenantScope(this.deps.pool, ctx.tenantId, (c) =>
      listBalancesRepo(c, {
        ...(f.account_id !== undefined ? { account_id: f.account_id } : {}),
        ...(f.as_of !== undefined ? { as_of: new Date(f.as_of) } : {}),
      }),
    );
    return rows.map(serializeBalance);
  }

  // ----- Writes (Phase 3+) -----------------------------------------------

  public upsertAccount(_ctx: ServiceCallContext, _input: UpsertAccountInput): Promise<Account> {
    return notImplemented("upsertAccount");
  }

  public recordTransaction(
    _ctx: ServiceCallContext,
    _input: RecordTransactionInput,
  ): Promise<Transaction> {
    return notImplemented("recordTransaction");
  }

  public upsertCounterparty(
    _ctx: ServiceCallContext,
    _input: UpsertCounterpartyInput,
  ): Promise<Counterparty> {
    return notImplemented("upsertCounterparty");
  }

  public normalizeFromRaw(
    _ctx: ServiceCallContext,
    _rawParsedId: string,
  ): Promise<{ created: Array<{ entity: string; id: string }> }> {
    return notImplemented("normalizeFromRaw");
  }

  // Helpers used by external callers that want to verify a row exists
  // (e.g. the §6 gate in Phase 4 will call these).
  public async findCounterpartyById(ctx: ServiceCallContext, id: string): Promise<Counterparty | null> {
    const row = await withTenantScope(this.deps.pool, ctx.tenantId, (c) => findCounterpartyById(c, id));
    return row === null ? null : serializeCounterparty(row);
  }

  public async findObligationById(ctx: ServiceCallContext, id: string): Promise<Obligation | null> {
    const row = await withTenantScope(this.deps.pool, ctx.tenantId, (c) => findObligationById(c, id));
    return row === null ? null : serializeObligation(row);
  }

  public async findInvoiceById(ctx: ServiceCallContext, id: string): Promise<Invoice | null> {
    const row = await withTenantScope(this.deps.pool, ctx.tenantId, (c) => findInvoiceById(c, id));
    return row === null ? null : serializeInvoice(row);
  }

  public async findDocumentById(ctx: ServiceCallContext, id: string): Promise<Document | null> {
    const row = await withTenantScope(this.deps.pool, ctx.tenantId, (c) => findDocumentById(c, id));
    return row === null ? null : serializeDocument(row);
  }
}

// ---------- Serializers ---------------------------------------------------

function commonFields(row: {
  id: string;
  owner_id: string;
  source_ids: string[];
  evidence_ids: string[];
  provenance: string;
  confidence: number;
  created_at: Date;
  updated_at: Date;
}) {
  return {
    id: row.id,
    owner_id: row.owner_id,
    source_ids: row.source_ids,
    evidence_ids: row.evidence_ids,
    provenance: row.provenance as Account["provenance"],
    confidence: row.confidence,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function serializeAccount(row: AccountRow): Account {
  return {
    ...commonFields(row),
    institution: row.institution,
    external_account_id: row.external_account_id,
    account_type: row.account_type as Account["account_type"],
    name: row.name,
    currency: row.currency,
    current_balance: row.current_balance,
    available_balance: row.available_balance,
    status: row.status as Account["status"],
  };
}

function serializeBalance(row: BalanceRow): Balance {
  return {
    ...commonFields(row),
    account_id: row.account_id,
    as_of: row.as_of.toISOString(),
    current_balance: row.current_balance,
    available_balance: row.available_balance,
    pending_balance: row.pending_balance,
    currency: row.currency,
  };
}

function serializeTransaction(row: TransactionRow): Transaction {
  return {
    ...commonFields(row),
    account_id: row.account_id,
    external_transaction_id: row.external_transaction_id,
    amount: row.amount,
    currency: row.currency,
    direction: row.direction as Transaction["direction"],
    transaction_date: row.transaction_date.toISOString(),
    posted_date: row.posted_date === null ? null : row.posted_date.toISOString(),
    counterparty_id: row.counterparty_id,
    category_id: row.category_id,
    status: row.status as Transaction["status"],
    description_raw: row.description_raw,
    description_normalized: row.description_normalized,
    reconciliation_status: row.reconciliation_status as Transaction["reconciliation_status"],
  };
}

function serializeCounterparty(row: CounterpartyRow): Counterparty {
  return {
    ...commonFields(row),
    name: row.name,
    normalized_name: row.normalized_name,
    type: row.type as Counterparty["type"],
    risk_level: row.risk_level as Counterparty["risk_level"],
    verified_status: row.verified_status as Counterparty["verified_status"],
    aliases: row.aliases,
    linked_accounts: row.linked_accounts,
  };
}

function serializeObligation(row: ObligationRow): Obligation {
  return {
    ...commonFields(row),
    type: row.type as Obligation["type"],
    counterparty_id: row.counterparty_id,
    amount_due: row.amount_due,
    minimum_due: row.minimum_due,
    currency: row.currency,
    due_date: row.due_date.toISOString(),
    recurrence: row.recurrence,
    status: row.status as Obligation["status"],
    linked_transaction_ids: row.linked_transaction_ids,
  };
}

function serializeInvoice(row: InvoiceRow): Invoice {
  return {
    ...commonFields(row),
    invoice_number: row.invoice_number,
    counterparty_id: row.counterparty_id,
    amount_due: row.amount_due,
    amount_paid: row.amount_paid,
    currency: row.currency,
    issue_date: row.issue_date.toISOString(),
    due_date: row.due_date === null ? null : row.due_date.toISOString(),
    status: row.status as Invoice["status"],
    linked_document_ids: row.linked_document_ids,
    linked_transaction_ids: row.linked_transaction_ids,
  };
}

function serializeDocument(row: DocumentRow): Document {
  return {
    ...commonFields(row),
    document_type: row.document_type as Document["document_type"],
    source_uri: row.source_uri,
    extracted_fields: row.extracted_fields,
    linked_account_ids: row.linked_account_ids,
    linked_transaction_ids: row.linked_transaction_ids,
    linked_obligation_ids: row.linked_obligation_ids,
    confidence_score: row.confidence_score,
  };
}

// ---------- Internals -----------------------------------------------------

function clampLimit(requested: number | undefined, fallback: number, max: number): number {
  if (requested === undefined) return fallback;
  if (requested < 1) return fallback;
  return Math.min(requested, max);
}

async function notImplemented(method: string): Promise<never> {
  throw brainError(
    "internal_server_error",
    `LedgerService.${method} is implemented in refactor phase 3+. Phase 2 ships read-only ledger.`,
  );
}
