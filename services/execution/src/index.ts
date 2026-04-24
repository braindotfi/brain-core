/**
 * @brain/execution
 *
 * Proposals, executions, agents, rails, MCP. 9 endpoints per
 * Brain_API_Specification.yaml §Execution.
 */

export const SERVICE_NAME = "brain-execution" as const;

export { buildExecutionApp, type BuildExecutionAppOptions } from "./server.js";
export type { ExecutionDeps } from "./deps.js";
export * from "./state-machines.js";
export {
  RailRegistry,
  BankAchRail,
  ErpWritebackRail,
  OnchainBaseRail,
  defaultRails,
} from "./rails/stubs.js";
export type {
  Rail,
  RailDispatchInput,
  RailDispatchResult,
  RailKind,
} from "./rails/types.js";
