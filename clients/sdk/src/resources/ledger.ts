import type { BrainHttpClient } from "../client.js";
import { BrainAPIError, type BrainErrorBody } from "../errors.js";
import type { components, operations, paths } from "../generated/openapi.js";

type Account = components["schemas"]["Account"];
type Balance = components["schemas"]["Balance"];
type Transaction = components["schemas"]["Transaction"];
type Counterparty = components["schemas"]["Counterparty"];
type Obligation = components["schemas"]["Obligation"];
type Invoice = components["schemas"]["Invoice"];

export type ListAccountsParams = NonNullable<
  paths["/ledger/accounts"]["get"]["parameters"]["query"]
>;
export type ListTransactionsParams = NonNullable<
  paths["/ledger/transactions"]["get"]["parameters"]["query"]
>;
export type CreateCounterpartyBody = NonNullable<
  operations["createCounterparty"]["requestBody"]
>["content"]["application/json"];
export type CreateCounterpartyResult =
  | operations["createCounterparty"]["responses"]["201"]["content"]["application/json"]
  | operations["createCounterparty"]["responses"]["200"]["content"]["application/json"];

export type UpdateCounterpartyBody = NonNullable<
  operations["updateCounterpartyIdentity"]["requestBody"]
>["content"]["application/json"];
export type UpdateCounterpartyResult =
  operations["updateCounterpartyIdentity"]["responses"]["200"]["content"]["application/json"];

export type ListCounterpartiesParams = NonNullable<
  paths["/ledger/counterparties"]["get"]["parameters"]["query"]
>;
export type ListObligationsParams = NonNullable<
  paths["/ledger/obligations"]["get"]["parameters"]["query"]
>;
export type ListInvoicesParams = NonNullable<
  paths["/ledger/invoices"]["get"]["parameters"]["query"]
>;
export type ListBalancesParams = NonNullable<
  paths["/ledger/balances"]["get"]["parameters"]["query"]
>;

export interface AccountListPage {
  accounts: Account[];
  nextCursor: string | null;
}
export interface AccountDetail {
  account: Account;
  latestBalance: Balance | undefined;
}
export interface TransactionListPage {
  transactions: Transaction[];
  nextCursor: string | null;
}
export type CounterpartyListPage = Counterparty[] & {
  counterparties: Counterparty[];
  nextCursor: string | null;
};
export type ObligationListPage = Obligation[] & {
  obligations: Obligation[];
  nextCursor: string | null;
};
export type InvoiceListPage = Invoice[] & {
  invoices: Invoice[];
  nextCursor: string | null;
};

function unwrap<T>(data: T | undefined, error: BrainErrorBody | undefined, status: number): T {
  if (error !== undefined || data === undefined) {
    throw new BrainAPIError(status, error);
  }
  return data;
}

export class AccountsResource {
  constructor(private readonly http: BrainHttpClient) {}

  async list(params: ListAccountsParams = {}): Promise<AccountListPage> {
    const { data, error, response } = await this.http.GET("/ledger/accounts", {
      params: { query: params },
    });
    const body = unwrap(data, error, response.status);
    return {
      accounts: body.accounts ?? [],
      nextCursor: body.next_cursor ?? null,
    };
  }

  async get(accountId: string): Promise<AccountDetail> {
    const { data, error, response } = await this.http.GET("/ledger/accounts/{account_id}", {
      params: { path: { account_id: accountId } },
    });
    const body = unwrap(data, error, response.status);
    if (!body.account) {
      throw new BrainAPIError(response.status, undefined);
    }
    return {
      account: body.account,
      latestBalance: body.latest_balance,
    };
  }

  /**
   * Requires `ledger:read`. Phase 4 resolution view: the reconciled money
   * pool for one account: balances reported per observation (never
   * adjudicated), confirmed-duplicate links followed, candidates pending
   * user review. Account duplicates never auto-match, so links here are
   * always human-confirmed.
   */
  async getResolved(
    accountId: string,
  ): Promise<operations["resolveAccount"]["responses"]["200"]["content"]["application/json"]> {
    const { data, error, response } = await this.http.GET(
      "/ledger/accounts/{account_id}/resolved",
      {
        params: { path: { account_id: accountId } },
      },
    );
    return unwrap(data, error, response.status);
  }
}

export class TransactionsResource {
  constructor(private readonly http: BrainHttpClient) {}

  async list(params: ListTransactionsParams = {}): Promise<TransactionListPage> {
    const { data, error, response } = await this.http.GET("/ledger/transactions", {
      params: { query: params },
    });
    const body = unwrap(data, error, response.status);
    return {
      transactions: body.transactions ?? [],
      nextCursor: body.next_cursor ?? null,
    };
  }

  async get(transactionId: string): Promise<Transaction> {
    const { data, error, response } = await this.http.GET("/ledger/transactions/{transaction_id}", {
      params: { path: { transaction_id: transactionId } },
    });
    return unwrap(data, error, response.status);
  }
}

export class CounterpartiesResource {
  constructor(private readonly http: BrainHttpClient) {}

  async list(params: ListCounterpartiesParams = {}): Promise<CounterpartyListPage> {
    const { data, error, response } = await this.http.GET("/ledger/counterparties", {
      params: { query: params },
    });
    const body = unwrap(data, error, response.status);
    const counterparties = body.counterparties ?? [];
    return attachListMetadata(counterparties, "counterparties", body.next_cursor ?? null);
  }

  /** Requires `ledger:read`. */
  async get(counterpartyId: string): Promise<Counterparty> {
    const { data, error, response } = await this.http.GET(
      "/ledger/counterparties/{counterparty_id}",
      { params: { path: { counterparty_id: counterpartyId } } },
    );
    return unwrap(data, error, response.status);
  }

  /**
   * Requires `ledger:write`. Manual, identity-only counterparty create,
   * governed by `docs/contracts/counterparty-manual.md`. Provenance,
   * confidence, `verified_status`, and `risk_level` are always
   * server-derived from the calling principal and cannot be set in the
   * body. Payment-rail fields (IBAN, account number, routing, SWIFT, BIC,
   * wallet, bank details) are rejected with `payment_fields_not_allowed`
   * and never written. Unknown fields return `unknown_field`. May return
   * `200` with `merged: true` instead of `201` if the create matched an
   * existing counterparty rather than creating a new one.
   */
  async create(body: CreateCounterpartyBody): Promise<CreateCounterpartyResult> {
    const { data, error, response } = await this.http.POST("/ledger/counterparties", { body });
    return unwrap(data, error, response.status);
  }

  /**
   * Requires `ledger:write` and a user principal (agent/API-partner
   * principals get `403 actor_unresolved`). Manual, identity-only edit,
   * same field restrictions as `create`. Renaming preserves the previous
   * name as an alias; a rename that collides with another counterparty's
   * name returns `409 name_conflict`.
   */
  async update(
    counterpartyId: string,
    body: UpdateCounterpartyBody,
  ): Promise<UpdateCounterpartyResult> {
    const { data, error, response } = await this.http.PATCH(
      "/ledger/counterparties/{counterparty_id}",
      { params: { path: { counterparty_id: counterpartyId } }, body },
    );
    return unwrap(data, error, response.status);
  }

  /**
   * Requires `ledger:read`. Phase 4 resolution view: the reconciled
   * organization for one counterparty: linked observations across
   * sources/types unioned into facets, name variants listed, and duplicate
   * candidates pending user review.
   */
  async getResolved(
    counterpartyId: string,
  ): Promise<operations["resolveCounterparty"]["responses"]["200"]["content"]["application/json"]> {
    const { data, error, response } = await this.http.GET(
      "/ledger/counterparties/{counterparty_id}/resolved",
      { params: { path: { counterparty_id: counterpartyId } } },
    );
    return unwrap(data, error, response.status);
  }
}

export class ObligationsResource {
  constructor(private readonly http: BrainHttpClient) {}

  async list(params: ListObligationsParams = {}): Promise<ObligationListPage> {
    const { data, error, response } = await this.http.GET("/ledger/obligations", {
      params: { query: params },
    });
    const body = unwrap(data, error, response.status);
    const obligations = body.obligations ?? [];
    return attachListMetadata(obligations, "obligations", body.next_cursor ?? null);
  }

  /**
   * Requires `ledger:read`. Phase 4 resolution view: the reconciled fact for
   * one obligation: every source observation retained, field-level
   * authority (which source owns each field), conflicts listed where
   * sources disagree, and duplicate candidates pending user review.
   */
  async getResolved(
    obligationId: string,
  ): Promise<operations["resolveObligation"]["responses"]["200"]["content"]["application/json"]> {
    const { data, error, response } = await this.http.GET(
      "/ledger/obligations/{obligation_id}/resolved",
      { params: { path: { obligation_id: obligationId } } },
    );
    return unwrap(data, error, response.status);
  }
}

export class InvoicesResource {
  constructor(private readonly http: BrainHttpClient) {}

  async list(params: ListInvoicesParams = {}): Promise<InvoiceListPage> {
    const { data, error, response } = await this.http.GET("/ledger/invoices", {
      params: { query: params },
    });
    const body = unwrap(data, error, response.status);
    const invoices = body.invoices ?? [];
    return attachListMetadata(invoices, "invoices", body.next_cursor ?? null);
  }

  async get(invoiceId: string): Promise<Invoice> {
    const { data, error, response } = await this.http.GET("/ledger/invoices/{invoice_id}", {
      params: { path: { invoice_id: invoiceId } },
    });
    return unwrap(data, error, response.status);
  }
}

function attachListMetadata<T, K extends string>(
  items: T[],
  key: K,
  nextCursor: string | null,
): T[] & Record<K, T[]> & { nextCursor: string | null } {
  Object.defineProperties(items, {
    [key]: { value: items, enumerable: false },
    nextCursor: { value: nextCursor, enumerable: false },
  });
  return items as T[] & Record<K, T[]> & { nextCursor: string | null };
}

export class BalancesResource {
  constructor(private readonly http: BrainHttpClient) {}

  async list(params: ListBalancesParams = {}): Promise<Balance[]> {
    const { data, error, response } = await this.http.GET("/ledger/balances", {
      params: { query: params },
    });
    const body = unwrap(data, error, response.status);
    return body.balances ?? [];
  }
}

export type NormalizeRawBody = NonNullable<
  operations["normalizeRaw"]["requestBody"]
>["content"]["application/json"];
export type NormalizeRawResult =
  operations["normalizeRaw"]["responses"]["200"]["content"]["application/json"];

export type RunReconciliationBody = NonNullable<
  operations["runReconciliation"]["requestBody"]
>["content"]["application/json"];
export type RunReconciliationResult =
  operations["runReconciliation"]["responses"]["202"]["content"]["application/json"];

export type ListReconciliationMatchesParams = NonNullable<
  operations["listReconciliationMatches"]["parameters"]["query"]
>;
export type ListReconciliationMatchesResult =
  operations["listReconciliationMatches"]["responses"]["200"]["content"]["application/json"];

/**
 * Tenant-wide ledger operations that don't belong to one entity type:
 * normalizing a Raw artifact into Ledger rows, running reconciliation, and
 * listing its matches. `normalize` requires `ledger:write`; `reconcile`
 * requires `ledger:write` and 501s if the deployment has no
 * `ReconciliationService` configured; `listMatches` requires `ledger:read`.
 */
export class LedgerOperationsResource {
  constructor(private readonly http: BrainHttpClient) {}

  /**
   * Idempotently normalizes a `raw_parsed` row into Ledger entities.
   * Re-running with the same `raw_parsed_id` returns the same row ids.
   */
  async normalize(body: NormalizeRawBody): Promise<NormalizeRawResult> {
    const { data, error, response } = await this.http.POST("/ledger/normalize", { body });
    return unwrap(data, error, response.status);
  }

  /** Enqueues a reconciliation run over recent ledger rows. */
  async reconcile(body: RunReconciliationBody = {}): Promise<RunReconciliationResult> {
    const { data, error, response } = await this.http.POST("/ledger/reconcile", { body });
    return unwrap(data, error, response.status);
  }

  async listReconciliationMatches(
    params: ListReconciliationMatchesParams = {},
  ): Promise<ListReconciliationMatchesResult> {
    const { data, error, response } = await this.http.GET("/ledger/reconciliation-matches", {
      params: { query: params },
    });
    return unwrap(data, error, response.status);
  }
}
