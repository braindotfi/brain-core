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

// Phase 4 — PaymentIntent lifecycle.
export { PaymentIntentService } from "./payment-intents/PaymentIntentService.js";
export type {
  PaymentIntentServiceDeps,
  PaymentIntentPolicyEvaluator,
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
  BankAchRail,
  ErpWritebackRail,
  OnchainBaseRail,
  defaultRails,
} from "./rails/stubs.js";
export type { Rail, RailDispatchInput, RailDispatchResult, RailKind } from "./rails/types.js";

// Boot-binary route registration hooks.
export { registerExecutionRoutes } from "./routes.js";
export { registerPaymentIntentRoutes } from "./payment-intents/routes.js";
