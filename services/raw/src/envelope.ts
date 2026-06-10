/**
 * Standard ingestion envelope (ingestion architecture §9).
 *
 * Every artifact that enters the raw layer, from any modality (webhook, pull,
 * file, customer push, agent contribution), may carry these declared fields.
 * They are metadata over an opaque payload: intake never parses the bytes and
 * never branches on them, so an artifact with a `source_schema` the system
 * has never seen still lands safely and waits for a parser.
 *
 * Three timestamps are kept distinct because financial data is corrected
 * retroactively:
 *  - `effectiveAt` is when the fact applied in the real world,
 *  - `observedAt` is when the source exposed it,
 *  - `ingested_at` (DB column, set at insert) is when Brain durably received it.
 *
 * `originalSource` + `intermediaries` keep the source chain visible through
 * aggregators (e.g. chase -> plaid -> brain), so Brain can always answer who
 * originally asserted a fact versus who transmitted it.
 */

export const INGEST_OPERATIONS = ["upsert", "delete", "snapshot"] as const;
export type IngestOperation = (typeof INGEST_OPERATIONS)[number];

export interface IngestEnvelopeFields {
  /** Declared payload schema tag, e.g. "quickbooks.invoice.v4". Never parsed at intake. */
  sourceSchema?: string;
  /** Provider object type, e.g. "invoice", "transaction". */
  objectType?: string;
  /** Provider-side id of the object this artifact describes. */
  externalId?: string;
  /** What the source asserts this artifact does to the object. */
  operation?: IngestOperation;
  /** When the fact applied in the real world (ISO 8601). */
  effectiveAt?: string;
  /** When the source exposed the fact (ISO 8601). */
  observedAt?: string;
  /** Who originally asserted the fact, when it differs from the connector (e.g. "chase" via plaid). */
  originalSource?: string;
  /** Transmitting parties between the original source and Brain, in order. */
  intermediaries?: readonly string[];
  /** raw_sources.id of the connection that produced this artifact, when one exists. */
  sourceId?: string;
  /** Provider version/sync token for this object state. */
  sourceVersion?: string;
  /** Caller idempotency key (e.g. connection:resource:object:version). Unique per tenant. */
  idempotencyKey?: string;
}
