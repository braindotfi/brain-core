/**
 * `brain.ledger.*` — the read-side of the Normalized Ledger (Layer 2).
 *
 * Surfaces six sub-namespaces matching the eleven Ledger entities at MVP
 * (accounts, transactions, balances, counterparties, obligations,
 * invoices). Sub-modules are exposed at the top level as
 * `brain.accounts`, `brain.transactions`, etc. for ergonomic
 * compatibility with the docs.brain.fi/build/* examples.
 *
 * Source pages:
 *   - https://docs.brain.fi/api-reference/ledger-api
 *   - https://docs.brain.fi/build/read-a-financial-picture
 *
 * @packageDocumentation
 */

import type { BrainHttp, RequestOptions } from "../http/index.js";
import type { Components } from "../index.js";

type Schemas = Components["schemas"];
export type Account = Schemas["Account"];
export type Balance = Schemas["Balance"];
export type Transaction = Schemas["Transaction"];
export type Counterparty = Schemas["Counterparty"];
export type Obligation = Schemas["Obligation"];
export type Invoice = Schemas["Invoice"];

/** Shared pagination shape returned by list endpoints. */
export interface Page<T> {
  readonly data: readonly T[];
  readonly nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// brain.accounts
// ---------------------------------------------------------------------------

export interface AccountsListOptions {
  readonly status?: "active" | "closed" | "frozen" | "pending";
  readonly accountType?: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly tenantId?: string;
}

/**
 * Accounts: bank accounts, cards, loans, on-chain addresses.
 *
 * Backs `brain.accounts.*`. Docs source:
 * https://docs.brain.fi/api-reference/ledger-api.
 */
export class AccountsModule {
  public constructor(private readonly http: BrainHttp) {}

  /**
   * List accounts for a tenant.
   *
   * Implements `GET /ledger/accounts` (operationId `listAccounts`).
   * @see https://docs.brain.fi/api-reference/ledger-api
   */
  public async list(tenantId: string, opts: AccountsListOptions = {}): Promise<Page<Account>> {
    const result = await this.http.get<{
      accounts: Account[];
      next_cursor: string | null;
    }>("/ledger/accounts", {
      query: {
        tenantId: tenantId,
        status: opts.status,
        account_type: opts.accountType,
        limit: opts.limit,
        cursor: opts.cursor,
      },
    });
    return { data: result.accounts, nextCursor: result.next_cursor };
  }

  /**
   * Get a single account by id, with its most recent balance.
   *
   * Implements `GET /ledger/accounts/{account_id}` (operationId
   * `getAccount`).
   * @see https://docs.brain.fi/api-reference/ledger-api
   */
  public async get(
    tenantId: string,
    accountId: string,
  ): Promise<{ account: Account; latest_balance: Balance }> {
    return this.http.get<{ account: Account; latest_balance: Balance }>(
      `/ledger/accounts/${encodeURIComponent(accountId)}`,
      { query: { tenantId } },
    );
  }
}

// ---------------------------------------------------------------------------
// brain.transactions
// ---------------------------------------------------------------------------

export interface TransactionsListOptions {
  readonly accountId?: string;
  readonly counterpartyId?: string;
  readonly direction?: "inflow" | "outflow" | "transfer" | "adjustment";
  readonly status?: "pending" | "posted" | "cleared" | "failed" | "reversed" | "disputed";
  readonly from?: string;
  readonly to?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export class TransactionsModule {
  public constructor(private readonly http: BrainHttp) {}

  /**
   * List transactions for a tenant.
   *
   * Implements `GET /ledger/transactions` (operationId `listTransactions`).
   * @see https://docs.brain.fi/api-reference/ledger-api
   */
  public async list(
    tenantId: string,
    opts: TransactionsListOptions = {},
  ): Promise<Page<Transaction>> {
    const result = await this.http.get<{
      transactions: Transaction[];
      next_cursor: string | null;
    }>("/ledger/transactions", {
      query: {
        tenantId,
        account_id: opts.accountId,
        counterparty_id: opts.counterpartyId,
        direction: opts.direction,
        status: opts.status,
        // Docs use `from`/`to`; spec uses `since`/`until`. We accept the
        // docs names at the SDK surface and translate to the spec names
        // on the wire.
        since: opts.from,
        until: opts.to,
        limit: opts.limit,
        cursor: opts.cursor,
      },
    });
    return { data: result.transactions, nextCursor: result.next_cursor };
  }

  /**
   * Get a single transaction by id.
   *
   * Implements `GET /ledger/transactions/{transaction_id}` (operationId
   * `getTransaction`).
   */
  public async get(tenantId: string, transactionId: string): Promise<Transaction> {
    return this.http.get<Transaction>(`/ledger/transactions/${encodeURIComponent(transactionId)}`, {
      query: { tenantId },
    });
  }
}

// ---------------------------------------------------------------------------
// brain.balances
// ---------------------------------------------------------------------------

export interface BalancesListOptions {
  readonly accountId?: string;
  readonly asOf?: string;
}

export class BalancesModule {
  public constructor(private readonly http: BrainHttp) {}

  /**
   * Point-in-time and historical balances.
   *
   * Implements `GET /ledger/balances` (operationId `listBalances`).
   */
  public async list(
    tenantId: string,
    opts: BalancesListOptions = {},
  ): Promise<{ balances: Balance[] }> {
    return this.http.get<{ balances: Balance[] }>("/ledger/balances", {
      query: {
        tenantId,
        account_id: opts.accountId,
        as_of: opts.asOf,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// brain.counterparties
// ---------------------------------------------------------------------------

export interface CounterpartiesListOptions {
  readonly q?: string;
  readonly type?:
    | "merchant"
    | "vendor"
    | "customer"
    | "employer"
    | "bank"
    | "wallet"
    | "exchange"
    | "tax_authority"
    | "other";
  readonly verifiedStatus?: string;
  readonly sortBy?: "activity" | "name" | "amount";
  readonly limit?: number;
}

export class CounterpartiesModule {
  public constructor(private readonly http: BrainHttp) {}

  /**
   * List/search counterparties.
   *
   * Implements `GET /ledger/counterparties` (operationId
   * `listCounterparties`).
   */
  public async list(
    tenantId: string,
    opts: CounterpartiesListOptions = {},
  ): Promise<{ counterparties: Counterparty[] }> {
    return this.http.get<{ counterparties: Counterparty[] }>("/ledger/counterparties", {
      query: {
        tenantId,
        q: opts.q,
        type: opts.type,
        verified_status: opts.verifiedStatus,
        sort_by: opts.sortBy,
        limit: opts.limit,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// brain.obligations
// ---------------------------------------------------------------------------

export interface ObligationsListOptions {
  readonly status?: "upcoming" | "due" | "paid" | "overdue" | "cancelled" | "disputed";
  readonly type?: string;
  readonly dueBefore?: string;
}

export class ObligationsModule {
  public constructor(private readonly http: BrainHttp) {}

  /**
   * List obligations (bills, invoices, subscriptions).
   *
   * Implements `GET /ledger/obligations` (operationId `listObligations`).
   */
  public async list(
    tenantId: string,
    opts: ObligationsListOptions = {},
  ): Promise<{ obligations: Obligation[] }> {
    return this.http.get<{ obligations: Obligation[] }>("/ledger/obligations", {
      query: {
        tenantId,
        status: opts.status,
        type: opts.type,
        due_before: opts.dueBefore,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// brain.invoices
// ---------------------------------------------------------------------------

export interface InvoicesListOptions {
  readonly status?: string;
  readonly counterpartyId?: string;
}

export class InvoicesModule {
  public constructor(private readonly http: BrainHttp) {}

  /**
   * List invoices.
   *
   * Implements `GET /ledger/invoices` (operationId `listInvoices`).
   */
  public async list(
    tenantId: string,
    opts: InvoicesListOptions = {},
    reqOpts: RequestOptions = {},
  ): Promise<{ invoices: Invoice[] }> {
    return this.http.get<{ invoices: Invoice[] }>("/ledger/invoices", {
      ...reqOpts,
      query: {
        tenantId,
        status: opts.status,
        counterparty_id: opts.counterpartyId,
      },
    });
  }
}
