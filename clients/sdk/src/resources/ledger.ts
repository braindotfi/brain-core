import type { BrainHttpClient } from "../client.js";
import { BrainAPIError, type BrainErrorBody } from "../errors.js";
import type { components, paths } from "../generated/openapi.js";

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

  async list(params: ListCounterpartiesParams = {}): Promise<Counterparty[]> {
    const { data, error, response } = await this.http.GET("/ledger/counterparties", {
      params: { query: params },
    });
    const body = unwrap(data, error, response.status);
    return body.counterparties ?? [];
  }
}

export class ObligationsResource {
  constructor(private readonly http: BrainHttpClient) {}

  async list(params: ListObligationsParams = {}): Promise<Obligation[]> {
    const { data, error, response } = await this.http.GET("/ledger/obligations", {
      params: { query: params },
    });
    const body = unwrap(data, error, response.status);
    return body.obligations ?? [];
  }
}

export class InvoicesResource {
  constructor(private readonly http: BrainHttpClient) {}

  async list(params: ListInvoicesParams = {}): Promise<Invoice[]> {
    const { data, error, response } = await this.http.GET("/ledger/invoices", {
      params: { query: params },
    });
    const body = unwrap(data, error, response.status);
    return body.invoices ?? [];
  }
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
