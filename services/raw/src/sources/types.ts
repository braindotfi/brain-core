/**
 * Source-connection types for the v0.3 /v1/sources/* API.
 *
 * PLAN-FIRST #12 (docs/sdk-audit.md). The 8-value MVP type set is locked
 * here per audit decision K2.
 *
 * @packageDocumentation
 */

/** v0.3 MVP source-connector vocabulary. */
export const SOURCE_TYPES = [
  "plaid",
  "stripe",
  "netsuite",
  "email_inbound",
  "csv_upload",
  "pdf_upload",
  "alchemy_wallet",
  "eth_address",
  "merge_accounting",
  "finch",
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/**
 * The single artifact-level source vocabulary (`raw_artifacts.source_type`).
 *
 * One provider-named set: the 8 connectable source types above, plus the
 * non-connector ingestion origins that write artifacts directly:
 *  - `agent_contributed`: agent-derived contributions (MCP `raw.contribute`),
 *  - `wiki_annotation`: human-declared corrections from the Wiki annotate path,
 *  - `other`: the universal fallback for sources with no native connector.
 *
 * Prior to the ingestion-architecture reconciliation the adapter layer and the
 * DB CHECK used a second, disagreeing vocabulary (`erp_netsuite`, `email`,
 * `upload`, `chain_evm`); migration raw/0007 renames those in place.
 */
export const ARTIFACT_SOURCE_TYPES = [
  ...SOURCE_TYPES,
  "agent_contributed",
  "wiki_annotation",
  "other",
] as const;
export type ArtifactSourceType = (typeof ARTIFACT_SOURCE_TYPES)[number];

/** Source-types with concrete adapter implementations in v0.3. */
export const CONCRETE_SOURCE_TYPES: ReadonlySet<SourceType> = new Set([
  "plaid",
  "stripe",
  "merge_accounting",
]);

/** Source-types that ship as stub connectors. Sync returns `{notes:"stub"}`. */
export const STUB_SOURCE_TYPES: ReadonlySet<SourceType> = new Set([
  "netsuite",
  "email_inbound",
  "csv_upload",
  "pdf_upload",
  "alchemy_wallet",
  "eth_address",
  "finch",
]);

export type SourceStatus = "active" | "paused" | "error" | "disconnected";

export interface SourceRecord {
  readonly id: string;
  readonly tenant_id: string;
  readonly type: SourceType;
  readonly status: SourceStatus;
  readonly metadata: Readonly<Record<string, unknown>>;
  /** Ledger external_account_id values reachable via this source (populated at connect time). */
  readonly external_account_ids?: readonly string[];
  readonly last_synced_at: string | null;
  readonly error_message: string | null;
  readonly is_stub: boolean;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ConnectInput {
  readonly tenant_id: string;
  readonly type: SourceType;
  /** Adapter-specific credentials. Validated per connector. */
  readonly credentials: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface SyncJobDescriptor {
  readonly job_id: string;
  readonly source_id: string;
  readonly status: "enqueued" | "running";
  readonly notes?: "stub";
}

/**
 * Wire shape returned by `/v1/sources/*` routes. Matches
 * components/schemas/Source in Brain_API_Specification.yaml.
 */
export interface SourceWire {
  readonly id: string;
  readonly tenantId: string;
  readonly type: SourceType;
  readonly status: SourceStatus;
  readonly last_synced_at: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly error_message: string | null;
  readonly is_stub: boolean;
  readonly created_at: string;
  readonly updated_at: string;
}

export function recordToWire(r: SourceRecord): SourceWire {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    type: r.type,
    status: r.status,
    last_synced_at: r.last_synced_at,
    metadata: r.metadata,
    error_message: r.error_message,
    is_stub: r.is_stub,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}
