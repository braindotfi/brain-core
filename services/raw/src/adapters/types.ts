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

import type { ArtifactSourceType } from "../sources/types.js";
import type { IngestEnvelopeFields } from "../envelope.js";

export interface FetchedArtifact {
  /** Canonical bytes. Adapter may stream, but for MVP we buffer. */
  body: Buffer;
  /** MIME type as reported by the source. Override via explicit form field. */
  mimeType: string | undefined;
  /** Source-specific identifiers (Plaid webhook_id, NetSuite internal_id, etc.). */
  sourceRef: Record<string, unknown>;
  /**
   * Standard ingestion envelope (§9): declared source_schema, the
   * effective/observed timestamps, source chain, object coordinates, and the
   * sync idempotency key. Optional — adapters fill what their provider exposes.
   */
  envelope?: IngestEnvelopeFields;
}

export type SyncCheckpointType = "cursor" | "page_token" | "watermark" | "snapshot";

/** Declares one partition an adapter syncs: a provider object type with its checkpoint style. */
export interface SyncObjectTypeSpec {
  readonly objectType: string;
  readonly checkpointType: SyncCheckpointType;
}

/** The committed state the worker hands an adapter for one partition pull. */
export interface SyncPartitionState {
  readonly sourceId: string;
  readonly resourceId: string;
  readonly objectType: string;
  readonly checkpointType: SyncCheckpointType;
  /** Last committed checkpoint; null means backfill from the beginning. */
  readonly committedCheckpoint: unknown;
}

export interface FetchIncrementalContext {
  readonly tenantId: string;
  /** Decrypted connection credentials, resolved by the worker; narrow + temporary. */
  readonly credentials: Record<string, unknown>;
  readonly partition: SyncPartitionState;
}

export interface FetchIncrementalResult {
  /** One bounded batch of artifacts. The worker durably commits these FIRST. */
  artifacts: FetchedArtifact[];
  /**
   * Checkpoint to commit AFTER the batch is durably ingested. Never advanced
   * by the adapter itself (anti-pattern: advancing a checkpoint before raw
   * data is durably committed).
   */
  nextCheckpoint: unknown;
  /** True when the provider signals more pages behind this checkpoint. */
  hasMore: boolean;
}

export interface SourceAdapter {
  /** Machine id — matches raw_artifacts.source_type (one reconciled vocabulary). */
  readonly sourceType: ArtifactSourceType;
  /**
   * When true, an artifact of this source_type may ONLY be created through an
   * authenticated provider path (the HMAC-verified `/raw/webhooks/{provider}`
   * route), never through the generic, caller-supplied `/raw/ingest` route.
   *
   * This is the authenticated-provenance boundary (Codex 2026-06-06 P1): the §6
   * gate maps `plaid`/`stripe` artifacts to HIGH evidence trust, so a generic
   * `raw:write` principal must not be able to MINT high-trust evidence by simply
   * labelling its upload `source_type: "plaid"`. Trust must derive from a
   * verified provider, not from a string the caller chose.
   */
  readonly providerAuthenticatedOnly?: boolean;
  /** For webhook-capable providers only. Others throw 501. */
  handleWebhook?(
    tenantId: string,
    rawBody: Buffer,
    headers: Record<string, unknown>,
  ): Promise<FetchedArtifact[]>;
  /**
   * Partitions this adapter syncs via fetchIncremental, one per provider
   * object type (§10 — never one cursor for the whole connection). The sync
   * worker materializes a raw_sync_partitions row per entry per connection.
   */
  readonly syncObjectTypes?: ReadonlyArray<SyncObjectTypeSpec>;
  /**
   * Authenticated incremental pull (ingestion method 2). Retrieves ONE
   * bounded batch behind the committed checkpoint and returns the artifacts
   * plus the next checkpoint. Pure with respect to Brain state: no DB or
   * blob writes — the worker owns persistence and checkpoint commit order.
   */
  fetchIncremental?(ctx: FetchIncrementalContext): Promise<FetchIncrementalResult>;
}
