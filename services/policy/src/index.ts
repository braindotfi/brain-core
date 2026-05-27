/**
 * @brain/policy
 *
 * Rule VM + versioned signable policies. 6 endpoints per
 * Brain_API_Specification.yaml §Policy.
 */

export const SERVICE_NAME = "brain-policy" as const;

export { buildPolicyApp, type BuildPolicyAppOptions } from "./server.js";
export type { PolicyDeps } from "./deps.js";
export {
  evaluate,
  compareDecimal,
  matchesCron,
  parseRequire,
  type Action,
  type Decision,
} from "./vm.js";
export {
  buildTypedData,
  computeDigest,
  digestHex,
  tenantIdToBytes32,
  type PolicyTypedData,
} from "./signing.js";
export { canonicalize, contentHash, contentHashHex, allowedActionsFor } from "./dsl.js";
export { simulateHistorical, type ReplayAction, type SimulationResult } from "./simulator.js";
export { lintPolicy, type LintFinding, type LintSeverity, type LintOptions } from "./linter.js";
export {
  diffPolicies,
  type PolicyDiff,
  type ModifiedRule,
  type RuleFieldChange,
} from "./policy-diff.js";
export {
  validateEvidence,
  type EvidenceValidationInput,
  type EvidenceValidationResult,
  type ResolvedEvidence,
} from "./evidence-validator.js";
export {
  detectDuplicates,
  type DuplicateCheckInput,
  type DuplicateCheckResult,
} from "./duplicate-detector.js";
// ERC-8004 reputation as a Policy threshold input (RFC 0001 §7.7) — tighten-only;
// never a §6 precondition. PR 4A: the pure adjustment + envelope reader; wiring
// into evaluateForGate is the follow-up.
export {
  applyReputationAdjustment,
  readReputationEnvelope,
  type ReputationScore,
  type ReputationResolver,
  type ReputationEnvelope,
} from "./reputation.js";
export type {
  ApplyTo,
  ExecuteMode,
  AmountLiteral,
  RuleWhen,
  PolicyRule,
  PolicyDocument,
  MessageTemplate,
  SpendWindowConstraint,
  TxCountWindowConstraint,
} from "./dsl.js";
export {
  isValidTransition,
  getActive,
  getById,
  type PolicyState,
  type PolicyRow,
} from "./repository.js";
export { registerPolicyRoutes } from "./routes.js";
export { PolicyService, type PolicyServiceDeps } from "./service.js";
export {
  bucketStart,
  readSpendWindow,
  readTxCountWindow,
  incrementSpendCounter,
} from "./spend-counters.js";
export {
  renderApprovedMessage,
  findMessageTemplate,
  type RenderedMessage,
} from "./message-templates.js";
