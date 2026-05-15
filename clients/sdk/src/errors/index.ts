/** Public error barrel for `@brain/sdk`. */

export {
  BRAIN_ERROR_CODES,
  isBrainErrorCode,
  type BrainErrorCode,
} from "./codes.js";

export {
  BRAIN_ERROR_CLASS_BY_CODE,
  BrainError,
  isBrainError,
  type BrainErrorOptions,
  // Auth
  AuthInvalidKeyError,
  AuthExpiredError,
  AuthSiwxInvalidError,
  ScopeInsufficientError,
  // Tenant
  TenantNotFoundError,
  TenantSuspendedError,
  TenantAccessDeniedError,
  // Source
  SourceNotFoundError,
  SourceRateLimitError,
  SourceCredentialInvalidError,
  // Policy
  PolicyNotActiveError,
  PolicyDeniedError,
  PolicyEscalateError,
  // Agent
  AgentNotFoundError,
  AgentInactiveError,
  ScopeHashMismatchError,
  ScopeExpiredError,
  // Action
  ActionNotFoundError,
  ActionAlreadyExecutedError,
  InsufficientBalanceError,
  LimitsExceededError,
  IdempotencyKeyReusedError,
  // Gate
  GateNoPolicyDecisionError,
  GatePolicyVersionStaleError,
  GateCounterpartyUnverifiedError,
  GateCounterpartySanctionedError,
  GateBalanceInsufficientError,
  GateApprovalIncompleteError,
  GateSessionKeyInvalidError,
  GateAuditChainStaleError,
  // Validation
  ValidationFailedError,
  MissingRequiredFieldError,
  InvalidCursorError,
  // Infrastructure
  RateLimitedError,
  InternalError,
  UpstreamTimeoutError,
  MaintenanceModeError,
} from "./BrainError.js";

export {
  brainErrorFromEnvelope,
  isBrainErrorEnvelope,
  type BrainErrorEnvelope,
} from "./parse.js";
