/**
 * `brain.sources.*` — source-connector lifecycle.
 *
 * Wraps the /v1/sources/* family added in PLAN-FIRST #12. Source:
 * https://docs.brain.fi/api-reference/sources-api.
 *
 * The 8 MVP source-type values are locked into the spec per
 * docs/sdk-audit.md decision K2; adding a value as more adapters ship
 * is a non-breaking enum widening.
 *
 * @packageDocumentation
 */

import type { BrainHttp } from "../http/index.js";
import type { Components } from "../index.js";

type Schemas = Components["schemas"];
export type Source = Schemas["Source"];
export type SourceType = Schemas["SourceType"];
export type SourceStatus = Schemas["SourceStatus"];

export interface ConnectSourceInput {
  readonly tenantId: string;
  readonly type: SourceType;
  /**
   * Provider-specific credentials. Schema depends on `type` — e.g.
   * Plaid `{access_token}`, Stripe `{api_key}`. Server validates per
   * adapter and returns `source_credential_invalid` on bad credentials.
   */
  readonly credentials: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly idempotencyKey?: string;
}

export interface ListSourcesOptions {
  readonly tenantId?: string;
  readonly type?: SourceType;
  readonly status?: SourceStatus;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface SyncJobDescriptor {
  readonly job_id: string;
  readonly source_id: string;
  readonly status: "enqueued" | "running";
  /** Set to `"stub"` when the underlying adapter is not yet live. */
  readonly notes?: "stub";
}

export class SourcesModule {
  public constructor(private readonly http: BrainHttp) {}

  /**
   * Connect a source.
   *
   * Implements `POST /sources` (operationId `connectSource`).
   * @see https://docs.brain.fi/api-reference/sources-api
   */
  public async connect(opts: ConnectSourceInput): Promise<Source> {
    return this.http.post<Source>(
      "/sources",
      {
        tenantId: opts.tenantId,
        type: opts.type,
        credentials: opts.credentials,
        ...(opts.metadata !== undefined ? { metadata: opts.metadata } : {}),
      },
      opts.idempotencyKey !== undefined
        ? { idempotencyKey: opts.idempotencyKey }
        : {},
    );
  }

  /**
   * List sources.
   *
   * Implements `GET /sources` (operationId `listSources`).
   */
  public async list(
    opts: ListSourcesOptions = {},
  ): Promise<{ data: Source[]; next_cursor: string | null }> {
    return this.http.get<{ data: Source[]; next_cursor: string | null }>(
      "/sources",
      {
        query: {
          tenantId: opts.tenantId,
          type: opts.type,
          status: opts.status,
          limit: opts.limit,
          cursor: opts.cursor,
        },
      },
    );
  }

  /**
   * Get a single source.
   *
   * Implements `GET /sources/{source_id}` (operationId `getSource`).
   */
  public async get(sourceId: string): Promise<Source> {
    return this.http.get<Source>(
      `/sources/${encodeURIComponent(sourceId)}`,
    );
  }

  /**
   * Disconnect a source. Ingestion stops immediately; Raw artifacts
   * remain queryable per retention policy.
   *
   * Implements `DELETE /sources/{source_id}` (operationId
   * `disconnectSource`).
   */
  public async disconnect(
    sourceId: string,
    opts: { idempotencyKey?: string } = {},
  ): Promise<Source> {
    return this.http.del<Source>(
      `/sources/${encodeURIComponent(sourceId)}`,
      opts.idempotencyKey !== undefined
        ? { idempotencyKey: opts.idempotencyKey }
        : {},
    );
  }

  /**
   * Trigger an immediate sync. Returns the sync job descriptor.
   * Stub-mode source types return `{notes: "stub"}` — check that flag
   * in caller UIs to grey out "sync now" buttons.
   *
   * Implements `POST /sources/{source_id}/sync` (operationId
   * `syncSource`).
   */
  public async sync(
    sourceId: string,
    opts: { idempotencyKey?: string } = {},
  ): Promise<SyncJobDescriptor> {
    return this.http.post<SyncJobDescriptor>(
      `/sources/${encodeURIComponent(sourceId)}/sync`,
      undefined,
      opts.idempotencyKey !== undefined
        ? { idempotencyKey: opts.idempotencyKey }
        : {},
    );
  }
}
