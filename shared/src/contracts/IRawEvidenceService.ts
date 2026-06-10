/**
 * IRawEvidenceService — Layer 1 boundary contract.
 *
 * Owns the immutable artifact store. Exposes ingestion and content-addressed
 * retrieval. Implementation: services/raw/.
 *
 * Layer boundary invariants:
 *  - Raw artifacts are content-addressed by sha256 within a tenant.
 *  - Mutation of an ingested artifact is forbidden — only tombstoning.
 *  - Parsed output is reproducible by replaying the parser at the recorded
 *    version against the immutable bytes.
 *  - Raw must NEVER store financial conclusions as authoritative facts;
 *    those live in the Ledger.
 */

import type { ServiceCallContext } from "./types.js";

export interface RawIngestRequest {
  sourceType: string; // raw_artifacts.source_type CHECK enum
  sourceRef: Record<string, unknown>;
  body: Buffer;
  mimeType?: string;
  /**
   * Standard ingestion envelope (ingestion architecture §9) — optional,
   * declared metadata over the opaque payload. Intake never parses the body
   * against `sourceSchema`; an unknown schema still ingests and waits for a
   * parser.
   */
  envelope?: {
    sourceSchema?: string;
    objectType?: string;
    externalId?: string;
    operation?: "upsert" | "delete" | "snapshot";
    effectiveAt?: string;
    observedAt?: string;
    originalSource?: string;
    intermediaries?: readonly string[];
    sourceId?: string;
    sourceVersion?: string;
    idempotencyKey?: string;
  };
}

export interface RawIngestResult {
  rawId: string;
  sha256: string;
  bytes: number;
  sourceType: string;
  ingestedAt: string;
  deduplicated: boolean;
}

export interface ParsedOutput {
  id: string;
  rawArtifactId: string;
  parser: string;
  parserVersion: string;
  extracted: Record<string, unknown>;
  confidence: number | null;
  extractedAt: string;
}

export interface IRawEvidenceService {
  /** Ingest an artifact. Idempotent by content-addressing on (tenant, sha256). */
  ingest(ctx: ServiceCallContext, req: RawIngestRequest): Promise<RawIngestResult>;

  /** Returns a short-lived signed URL for the artifact bytes. */
  signedUrl(ctx: ServiceCallContext, rawId: string, ttlSeconds: number): Promise<string>;

  /** Returns the parser-output rows for an artifact. */
  listParsed(ctx: ServiceCallContext, rawId: string): Promise<ParsedOutput[]>;

  /** Tombstones an artifact. Bytes are retained per regulatory policy. */
  tombstone(ctx: ServiceCallContext, rawId: string): Promise<void>;
}
