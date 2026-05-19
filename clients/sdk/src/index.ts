export { Brain, type BrainOptions, type PayResult } from "./brain.js";

export {
  createBrainHttpClient,
  type BrainHttpClient,
  type BrainHttpClientOptions,
} from "./client.js";

export {
  BrainAPIError,
  PolicyApprovalRequiredError,
  PolicyRejectedError,
  type BrainErrorBody,
  type PaymentIntent,
  type Proposal,
} from "./errors.js";

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

export {
  AnchorResource,
  AuditResource,
  type AnchorRecord,
  type AuditEventListPage,
  type AuditEventWithProof,
  type EntityAuditHistory,
  type EntityType,
  type ExportAuditJob,
  type ExportAuditRequest,
  type InclusionProof,
  type ListAuditEventsParams,
  type VerifyAuditRequest,
  type VerifyAuditResult,
} from "./resources/audit.js";

export {
  PaymentsResource,
  type CreatePaymentIntentParams,
  type ExecutionReceipt,
  type RejectPaymentIntentParams,
} from "./resources/payments.js";

export {
  ActionsResource,
  type ApproveProposalParams,
  type EscalateProposalParams,
  type ExecuteProposalParams,
  type ProposeActionParams,
  type StartedExecution,
} from "./resources/actions.js";

export type { paths, components, operations } from "./generated/openapi.js";
