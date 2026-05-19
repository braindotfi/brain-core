/**
 * Source adapter interface.
 *
 * A source adapter knows how to produce artifact bytes + source_ref from a
 * provider-specific representation. For direct uploads this is trivial —
 * the bytes arrive in the request. For Plaid/Gmail/etc. the adapter fetches
 * from the provider API using tenant-scoped credentials.
 *
 * Adapters do NOT write to the DB or Blob store — that is the `ingestOne`
 * orchestrator's job in `src/services/ingest.ts`. Adapters return a
 * normalized representation and let the orchestrator handle persistence,
 * dedup, and audit.
 */

export interface FetchedArtifact {
  /** Canonical bytes. Adapter may stream, but for MVP we buffer. */
  body: Buffer;
  /** MIME type as reported by the source. Override via explicit form field. */
  mimeType: string | undefined;
  /** Source-specific identifiers (Plaid webhook_id, NetSuite internal_id, etc.). */
  sourceRef: Record<string, unknown>;
}

export interface SourceAdapter {
  /** Machine id — matches raw_artifacts.source_type. */
  readonly sourceType: string;
  /** For webhook-capable providers only. Others throw 501. */
  handleWebhook?(
    tenantId: string,
    rawBody: Buffer,
    headers: Record<string, unknown>,
  ): Promise<FetchedArtifact[]>;
}
