/**
 * @brain/internal-agents — the Brain-shipped (internal) agent catalog.
 *
 * Defines the agent handler contract, the per-agent definitions + handlers +
 * policy templates, the catalog the router selects over, and the on-chain
 * registration payloads. Agents propose through the existing path; they never
 * execute. Consumed by @brain/agent-router and the API boot binary.
 */

export * from "./evidence.js";
export * from "./handler.js";
export * from "./payloads.js";
export {
  internalAgentCatalog,
  internalAgentDefinitions,
  internalAgentHandlers,
} from "./registry.js";
export * from "./registration.js";
