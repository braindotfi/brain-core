export {
  Brain,
  BRAIN_BASE_URLS,
  resolveBaseUrl,
  type BrainOptions,
  type PayResult,
} from "./brain.js";

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
  ProofResource,
  type Proof,
  type ProofGateCheck,
  type ProofEvidence,
  type ProofAuditEvent,
  type ProofChainAnchor,
  type ProofOutcome,
} from "./resources/proof.js";

export {
  AgentRunsResource,
  type AgentRunSummary,
  type AgentRunWhy,
  type AgentRunEvidenceItem,
  type AgentRunGateTrace,
} from "./resources/agent-runs.js";

export {
  PaymentsResource,
  type CreatePaymentIntentParams,
  type ExecutionReceipt,
  type RejectPaymentIntentParams,
} from "./resources/payments.js";

export {
  ProposalsResource,
  type AgentOutputProposal,
  type ListProposalsParams,
  type ProposalDecision,
  type ProposalDecisionResult,
} from "./resources/proposals.js";
export {
  EvidenceResource,
  type EvidenceResolveRef,
  type EvidenceResolveResult,
} from "./resources/evidence.js";

export {
  ActionsResource,
  type ApproveProposalParams,
  type EscalateProposalParams,
  type ExecuteProposalParams,
  type ProposeActionParams,
  type StartedExecution,
} from "./resources/actions.js";

export {
  AgentsResource,
  type AgentActionsList,
  type ListAgentActionsParams,
  type ProposeFromAgentResult,
  type RegisterAgentBody,
} from "./resources/agents.js";

export {
  RawResource,
  type GetParsedParams,
  type IngestFromUrlParams,
  type ParsedRaw,
  type RawArtifact,
  type SourceSyncJobResult,
} from "./resources/raw.js";

export { TenantsResource, type TenantExportJob } from "./resources/tenants.js";

export {
  WikiResource,
  type AnnotationResult,
  type AskParams,
  type EntityVersionHistory,
  type GetWikiEntityParams,
  type SchemaQuery,
  type SearchWikiParams,
  type WikiEntityWithNeighbors,
  type WikiSearchResult,
} from "./resources/wiki.js";

export {
  PolicyResource,
  type PolicySignatureSubmission,
  type PolicySigningPayload,
  type SimulatePolicyParams,
} from "./resources/policy.js";

export {
  CashFlowResource,
  CompoundsResource,
  type ActionTrace,
  type CashFlowSummarizeParams,
  type CashFlowSummary,
  type FinancialSnapshot,
  type SnapshotOptions,
  type TraceEntry,
} from "./resources/compounds.js";

export type { paths, components, operations } from "./generated/openapi.js";
