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
export {
  validateEvidence,
  type EvidenceValidationInput,
  type EvidenceValidationResult,
  type ResolvedEvidence,
} from "./evidence-validator.js";
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
