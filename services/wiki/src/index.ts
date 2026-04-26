/**
 * @brain/wiki
 *
 * Layer 3 — human-readable memory. v0.3 narrows the role: financial truth
 * lives in the Ledger (Layer 2), Wiki holds memory pages and the Q&A
 * surface. Kind enum is restricted to {policy, agent} pointer types via
 * migration 0003. Plaid extraction moved to @brain/ledger/extractors.
 *
 * Phase 5 adds wiki_pages (migration 0004) and the WikiPageService that
 * renders pages from current Ledger state. /memory/* endpoints register
 * alongside /wiki/*.
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
  type AskEvidenceItem,
} from "./question/orchestrator.js";

// Phase 5 — page rendering.
export { WikiPageService } from "./pages/WikiPageService.js";
export type { WikiPageServiceDeps } from "./pages/WikiPageService.js";
export type { PageGenerator, PageGenerationContext, PageGenerationOutput } from "./pages/types.js";
