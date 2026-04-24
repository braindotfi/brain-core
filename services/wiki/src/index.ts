/**
 * @brain/wiki
 *
 * Structured memory. Postgres + pgvector. Bitemporal entity/relation graph.
 * 7 endpoints per Brain_API_Specification.yaml §Wiki.
 */

export const SERVICE_NAME = "brain-wiki" as const;

export { buildWikiApp, type BuildWikiAppOptions } from "./server.js";
export { loadRegistry, type SchemaRegistry } from "./schemas.js";
export type { WikiDeps } from "./deps.js";
export {
  askWiki,
  type AskOptions,
  type AskResult,
  type AskDeps,
} from "./question/orchestrator.js";
export {
  extractPlaidTransactions,
  type PlaidExtractInput,
  type PlaidTransaction,
  type ExtractResult,
} from "./extractors/plaid.js";
