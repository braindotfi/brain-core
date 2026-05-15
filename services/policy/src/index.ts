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
export { canonicalize, contentHash, contentHashHex } from "./dsl.js";
export type {
  ApplyTo,
  ExecuteMode,
  AmountLiteral,
  RuleWhen,
  PolicyRule,
  PolicyDocument,
} from "./dsl.js";
export { isValidTransition, type PolicyState, type PolicyRow } from "./repository.js";
export { registerPolicyRoutes } from "./routes.js";
