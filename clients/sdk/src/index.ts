export { Brain, type BrainOptions } from "./brain.js";

export {
  createBrainHttpClient,
  type BrainHttpClient,
  type BrainHttpClientOptions,
} from "./client.js";

export { BrainAPIError, type BrainErrorBody } from "./errors.js";

export {
  AccountsResource,
  BalancesResource,
  CounterpartiesResource,
  InvoicesResource,
  ObligationsResource,
  TransactionsResource,
  type AccountDetail,
  type AccountListPage,
  type ListAccountsParams,
  type ListBalancesParams,
  type ListCounterpartiesParams,
  type ListInvoicesParams,
  type ListObligationsParams,
  type ListTransactionsParams,
  type TransactionListPage,
} from "./resources/ledger.js";

export type { paths, components, operations } from "./generated/openapi.js";
