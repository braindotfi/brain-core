/**
 * Parser registry — one dispatch table keyed by parser id.
 *
 * Ingestion architecture, Appendix B mechanisms 2 and 4: interpretation is a
 * separate, versioned, replayable extractor. The normalize worker polls every
 * registered parser and dispatch lives here, so registering a new parser
 * requires no worker or LedgerService change. An extractor is pure with
 * respect to the source: it reads the already-persisted raw_parsed payload
 * and writes Ledger rows through the provenance-validating writers; it never
 * contacts the provider.
 */

import type { Pool } from "pg";
import type { AuditEmitter, ServiceCallContext } from "@brain/shared";
import { normalizePlaidArtifact } from "./plaid.js";
import { normalizeDocObligationArtifact } from "./doc-obligation.js";

export interface ParserExtractInput {
  rawParsedId: string;
  rawArtifactId: string;
  payload: Record<string, unknown>;
  /** raw_parsed.confidence; null when the producer did not assert one. */
  confidence: number | null;
}

export interface ExtractedRow {
  entity: string;
  id: string;
}

export type ParserExtractor = (
  pool: Pool,
  audit: AuditEmitter,
  ctx: ServiceCallContext,
  input: ParserExtractInput,
) => Promise<ExtractedRow[]>;

/**
 * Default confidence for document-extraction payloads whose producer did not
 * assert one. Matches the agent_contributed cappedConfidence ceiling in
 * service/writes.ts, so an unasserted document lands at the cap, never above.
 */
const AGENT_CONTRIBUTED_DOC_CONFIDENCE = 0.5;

const REGISTRY = new Map<string, ParserExtractor>();

/** Register an extractor for a parser id. A parser id registers exactly once. */
export function registerParser(parserId: string, extractor: ParserExtractor): void {
  if (REGISTRY.has(parserId)) {
    throw new Error(`parser '${parserId}' is already registered`);
  }
  REGISTRY.set(parserId, extractor);
}

export function extractorForParser(parserId: string): ParserExtractor | undefined {
  return REGISTRY.get(parserId);
}

/** Parser ids the normalize worker polls for. Stable order for SQL ANY($). */
export function registeredParsers(): string[] {
  return [...REGISTRY.keys()].sort();
}

// ---------------------------------------------------------------------------
// Built-in parsers. Behavior is unchanged from the pre-registry dispatch:
// the worker's hardcoded plaid_tx_v1 poll and the doc_obligation_v1 switch
// case in LedgerService both folded into this table.
// ---------------------------------------------------------------------------

registerParser("plaid_tx_v1", async (pool, audit, ctx, input) =>
  normalizePlaidArtifact(pool, audit, ctx, {
    rawParsedId: input.rawParsedId,
    rawArtifactId: input.rawArtifactId,
    payload: input.payload,
  }),
);

registerParser("doc_obligation_v1", async (pool, audit, ctx, input) =>
  normalizeDocObligationArtifact(pool, audit, ctx, {
    rawParsedId: input.rawParsedId,
    rawArtifactId: input.rawArtifactId,
    payload: input.payload,
    confidence: input.confidence ?? AGENT_CONTRIBUTED_DOC_CONFIDENCE,
  }),
);
