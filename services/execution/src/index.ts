/**
 * @brain/execution
 *
 * Proposals, executions, agents, rails, MCP — Stage 6.
 * PaymentIntent + §6 pre-execution gate — refactor-4.
 *
 * Routes registered by buildExecutionApp:
 *   - /execution/*          (legacy, retained for v0.3 transition)
 *   - /payment-intents/*    (v0.3, Phase 4)
 */

export const SERVICE_NAME = "brain-execution" as const;

export { buildExecutionApp, type BuildExecutionAppOptions } from "./server.js";
export type { ExecutionDeps } from "./deps.js";
export * from "./state-machines.js";

// Phase 4 — PaymentIntent lifecycle + non-financial agent proposals.
export { PaymentIntentService } from "./payment-intents/PaymentIntentService.js";
export {
  EXECUTABLE_PAYMENT_INTENT_ACTION_TYPES,
  isExecutablePaymentIntentActionType,
  type ExecutablePaymentIntentActionType,
} from "./payment-intents/action-types.js";
export { AgentService } from "./AgentService.js";
export type { AgentServiceDeps } from "./AgentService.js";
export {
  UnconfiguredRegistrationRelayer,
  type AgentRegistrationRelayer,
  type AgentRegistrationRequest,
  type AgentRegistrationResult,
} from "./registration-relayer.js";
export type {
  PaymentIntentServiceDeps,
  PaymentIntentPolicyEvaluator,
  OnchainDispatchParams,
} from "./payment-intents/PaymentIntentService.js";
export {
  isValidPaymentIntentTransition,
  assertPaymentIntentTransition,
  type PaymentIntentState,
} from "./payment-intents/state-machine.js";
export { ApprovalService } from "./approvals/ApprovalService.js";
export type { ApprovalServiceDeps } from "./approvals/ApprovalService.js";
export { ActorResolver, actorUnresolved } from "./members/ActorResolver.js";
export {
  authorizeApproval,
  decimalAmountToCents,
  paymentIntentApprovalDomain,
  type ApprovalAuthorization,
  type ApprovalRejectionReason,
} from "./members/authorizeApproval.js";
export {
  PostgresMemberLookup,
  findMemberByEmail,
  findMemberById,
  findMemberByIdentityLink,
} from "./members/repository.js";
export type {
  ActorContext,
  ActorVerification,
  ApprovalDomain,
  MemberAuthority,
  MemberIdentitySurface,
  MemberLookup,
  MemberRole,
  ResolveActorInput,
  SignedApprovalTokenClaims,
} from "./members/types.js";

// Stage 6 — rails.
export {
  RailRegistry,
  BankAchStubRail,
  ErpWritebackStubRail,
  OnchainBaseStubRail,
  defaultRails,
} from "./rails/stubs.js";
export type { Rail, RailDispatchInput, RailDispatchResult, RailKind } from "./rails/types.js";
// H-05 — real Plaid Transfer ACH rail + webhook settlement mapper.
export {
  AchPlaidRail,
  applyPlaidTransferEvent,
  classifyPlaidTransferStatus,
  type AchPlaidRailDeps,
  type AchTransferAction,
  type PlaidAuthorizationResponse,
  type PlaidTransferClient,
  type PlaidTransferEvent,
  type PlaidTransferResponse,
} from "./rails/ach-plaid.js";
// H-06 — real on-chain Base rail (BrainSmartAccount.executeViaSessionKey).
export {
  OnchainBaseRail,
  getSessionKeyNonce,
  type OnchainBaseAction,
  type OnchainBaseRailDeps,
  type OnchainExecuteArgs,
  type OnchainExecuteResult,
  type OnchainExecutor,
  type SessionKeyNonceReader,
} from "./rails/onchain-base.js";
// Deterministic-revert classification (permanent dispatch failures).
export {
  classifyDeterministicRevert,
  permanentFailureReason,
  DETERMINISTIC_SMART_ACCOUNT_REVERTS,
  type DeterministicRevert,
} from "./rails/permanent-failure.js";
export {
  X402BaseRail,
  type X402BaseRailDeps,
  type X402Client,
  type X402SettleArgs,
  type X402SettleResult,
} from "./rails/x402-base.js";
export { EscrowBaseRail, type EscrowBaseRailDeps } from "./rails/escrow-base.js";
// Phase 4 — open-ecosystem (4337 / Coinbase Smart Wallet) authorization model + resolver.
export {
  validateSpendPermission,
  toMicropaymentWindowCap,
  toSessionKeyShape,
  type SpendPermission,
  type SpendRequest,
  type SpendValidation,
} from "./open-ecosystem/spend-permission.js";
export {
  resolveSpendPermissionSettlement,
  type SpendPermissionResolverDeps,
  type ResolvedSpendPermissionIntent,
} from "./open-ecosystem/spend-permission-resolver.js";

// Boot-binary route registration hooks.
export { registerExecutionRoutes } from "./routes.js";
export { registerPaymentIntentRoutes } from "./payment-intents/routes.js";
export type {
  InvoiceShortcutResolver,
  PaymentIntentAgentResolver,
} from "./payment-intents/routes.js";
export { registerProposalReadRoutes } from "./proposals/routes.js";
export { registerEvidenceResolveRoutes } from "./evidence/routes.js";
export type { EvidenceResolveRoutesDeps } from "./evidence/routes.js";
export {
  canonicalEvidenceKind,
  evidenceKindFromRefPrefix,
  isEvidenceKindResolvable,
  isEvidenceRefResolvable,
  parseEvidenceResolveBody,
  resolveEvidenceRefs,
  unsupportedEvidenceKinds,
  type EvidenceResolveRef,
  type EvidenceResolveResult,
} from "./evidence/resolve.js";
export {
  ProposalDecisionService,
  PROPOSAL_DECISIONS,
  type ProposalDecision,
  type ProposalDecisionResult,
  type ProposalDecisionServiceDeps,
} from "./proposals/decision-service.js";
export type {
  ListProposalsInput,
  ListProposalsResult,
  ProposalAgentRef,
  ProposalEvidenceRef,
  ProposalMode,
  ProposalReadItem,
  ProposalRiskBand,
  ProposalType,
} from "./proposals/read-model.js";
export { getPaymentIntentAgent, PROPOSAL_TYPES } from "./proposals/read-model.js";
export { registerMemberRoutes } from "./members/routes.js";
export type { MemberRoutesDeps } from "./members/routes.js";

// P0.5 invoice shortcut resolver + injected lookups.
export { resolveInvoiceShortcut } from "./payment-intents/invoice-shortcut.js";
export type {
  InvoiceShortcutDeps,
  InvoiceShortcutInvoice,
  ResolvedInvoiceShortcut,
} from "./payment-intents/invoice-shortcut.js";

// Repository primitives exposed for boot-binary dependency wiring.
export { findAgent, findUser, transitionAgent } from "./repository.js";
export type { AgentRow, UserRow } from "./repository.js";
// H-09 agent contribution hold.
export {
  shouldQuarantineContribution,
  recordContributionAndDecide,
  releaseContributionHold,
  requireReleaseContributionHold,
  type AgentContributionHoldState,
} from "./agents/quarantine.js";

// Agent-run persistence (Agent Autonomy v3, 1a.3 + 1a.5).
export * from "./agent-runs.js";
// High-risk findings + overrides (Agent Autonomy v3, 2.6).
export * from "./findings.js";
// Agent-to-agent sagas (Agent Autonomy v3, 3.2).
export { runSaga, type SagaStep, type SagaResult, type SagaDeps } from "./sagas.js";
// Durable execution outbox + saga (H-04).
export {
  OutboxService,
  payloadHash,
  MAX_DISPATCH_ATTEMPTS,
  MAX_TOTAL_DISPATCH_ATTEMPTS,
  RETRY_BACKOFF_BASE_SECONDS,
  RETRY_BACKOFF_CAP_SECONDS,
  type OutboxRow,
  type OutboxStatus,
  type EnqueueInput,
  type EnqueueResult,
} from "./outbox/OutboxService.js";
export {
  runOutboxCycle,
  processClaimedRow,
  startOutboxWorker,
  type OutboxExecutor,
  type OutboxWorkerDeps,
  type CycleResult,
  type RowOutcome,
} from "./outbox/worker.js";
// Per-task minimum-privilege session keys (Agent Autonomy v3, 3.3).
export {
  derivePerTaskSessionKey,
  DEFAULT_TASK_KEY_TTL_SECONDS,
  type PerTaskSessionKeyParams,
  type DerivePerTaskKeyInput,
} from "./rails/session-keys.js";
export {
  redact,
  DEFAULT_AGENT_TRACE_POLICY,
  type RedactionPolicy,
  type RedactionRule,
  type RedactionTransform,
  type RedactOptions,
} from "./redaction.js";
