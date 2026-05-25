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
export { AgentService } from "./AgentService.js";
export type { AgentServiceDeps } from "./AgentService.js";
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

// Boot-binary route registration hooks.
export { registerExecutionRoutes } from "./routes.js";
export { registerPaymentIntentRoutes } from "./payment-intents/routes.js";

// Repository primitives exposed for boot-binary dependency wiring.
export { findAgent, findUser, transitionAgent } from "./repository.js";
export type { AgentRow, UserRow } from "./repository.js";
// H-09 agent-contribution quarantine.
export {
  shouldQuarantineContribution,
  recordContributionAndDecide,
  releaseAgentQuarantine,
  requireReleaseAgentQuarantine,
  type AgentQuarantineState,
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
