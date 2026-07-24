import type { BrainHttpClient } from "../client.js";
import { BrainAPIError, type BrainErrorBody } from "../errors.js";
import type { components, operations, paths } from "../generated/openapi.js";

type RawIngestResponse = components["schemas"]["RawIngestResponse"];
type RawSourceType = components["schemas"]["RawSourceType"];
type RawParsed = components["schemas"]["RawParsed"];
type RawExtractionJob = components["schemas"]["RawExtractionJob"];
type Source = components["schemas"]["Source"];
type SourceSyncJob = components["schemas"]["SourceSyncJob"];

export interface IngestFromUrlParams {
  sourceType: RawSourceType;
  url: string;
  sourceRef?: Record<string, unknown>;
  authHeader?: string;
}

export interface RawArtifact {
  rawId: string | undefined;
  sha256: string | undefined;
  signedUrl: string | undefined;
  expiresAt: string | undefined;
  mimeType: string | undefined;
  bytes: number | undefined;
}

export interface ParsedRaw {
  rawId: string | undefined;
  parsed: RawParsed[];
}

export interface RawExtractResult {
  jobId: string;
  rawId: string;
  status: RawExtractionJob["status"];
  parsedId: string | null;
  confidence: number | null;
  error: Record<string, unknown> | null;
  nextAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SourceSyncJobResult {
  jobId: string;
  sourceId: string;
  status: SourceSyncJob["status"];
  errorMessage: string | null;
  notes: SourceSyncJob["notes"];
  createdAt: string | undefined;
  updatedAt: string | undefined;
}

export interface SourceListPage {
  sources: Source[];
  nextCursor: string | null;
}

export type GetParsedParams = NonNullable<
  paths["/raw/{raw_id}/parsed"]["get"]["parameters"]["query"]
>;
export type ListSourcesParams = NonNullable<paths["/sources"]["get"]["parameters"]["query"]>;

export type WriteRawParsedBody = NonNullable<
  operations["writeRawParsed"]["requestBody"]
>["content"]["application/json"];

export type ConnectSourceBody = NonNullable<
  operations["connectSource"]["requestBody"]
>["content"]["application/json"];

function unwrap<T>(data: T | undefined, error: BrainErrorBody | undefined, status: number): T {
  if (error !== undefined || data === undefined) {
    throw new BrainAPIError(status, error);
  }
  return data;
}

export class RawResource {
  constructor(private readonly http: BrainHttpClient) {}

  /**
   * URL-based ingestion. The server fetches the artifact server-side
   * (must be HTTPS) and ingests it. For binary uploads, use the
   * low-level `brain.http.POST("/raw/ingest", ...)` with a multipart
   * body (binary support not yet wrapped in this SDK).
   */
  async ingest(params: IngestFromUrlParams): Promise<RawIngestResponse> {
    const body: {
      source_type: RawSourceType;
      url: string;
      source_ref?: Record<string, unknown>;
      auth_header?: string;
    } = {
      source_type: params.sourceType,
      url: params.url,
    };
    if (params.sourceRef !== undefined) body.source_ref = params.sourceRef;
    if (params.authHeader !== undefined) body.auth_header = params.authHeader;
    const { data, error, response } = await this.http.POST("/raw/ingest", {
      body,
    });
    return unwrap(data, error, response.status);
  }

  async get(rawId: string): Promise<RawArtifact> {
    const { data, error, response } = await this.http.GET("/raw/{raw_id}", {
      params: { path: { raw_id: rawId } },
    });
    const body = unwrap(data, error, response.status);
    return {
      rawId: body.raw_id,
      sha256: body.sha256,
      signedUrl: body.signed_url,
      expiresAt: body.expires_at,
      mimeType: body.mime_type,
      bytes: body.bytes,
    };
  }

  async getParsed(rawId: string, params: GetParsedParams = {}): Promise<ParsedRaw> {
    const { data, error, response } = await this.http.GET("/raw/{raw_id}/parsed", {
      params: { path: { raw_id: rawId }, query: params },
    });
    const body = unwrap(data, error, response.status);
    return {
      rawId: body.raw_id,
      parsed: body.parsed ?? [],
    };
  }

  async extract(rawId: string): Promise<RawExtractResult> {
    const { data, error, response } = await this.http.POST("/raw/{raw_id}/extract", {
      params: { path: { raw_id: rawId } },
    });
    const body = unwrap(data, error, response.status);
    return mapExtractionJob(body);
  }

  async getExtraction(rawId: string): Promise<RawExtractResult> {
    const { data, error, response } = await this.http.GET("/raw/{raw_id}/extraction", {
      params: { path: { raw_id: rawId } },
    });
    return mapExtractionJob(unwrap(data, error, response.status));
  }

  async listSources(params: ListSourcesParams = {}): Promise<SourceListPage> {
    const { data, error, response } = await this.http.GET("/sources", {
      params: { query: params },
    });
    const body = unwrap(data, error, response.status);
    return {
      sources: body.data ?? [],
      nextCursor: body.next_cursor ?? null,
    };
  }

  async syncSource(sourceId: string): Promise<SourceSyncJobResult> {
    const { data, error, response } = await this.http.POST("/sources/{source_id}/sync", {
      params: { path: { source_id: sourceId } },
    });
    return mapSourceSyncJob(unwrap(data, error, response.status));
  }

  async getSourceSyncJob(sourceId: string, jobId: string): Promise<SourceSyncJobResult> {
    const { data, error, response } = await this.http.GET("/sources/{source_id}/sync/{job_id}", {
      params: { path: { source_id: sourceId, job_id: jobId } },
    });
    return mapSourceSyncJob(unwrap(data, error, response.status));
  }

  /**
   * Requires `raw:admin` (not `raw:write`), a higher bar than every other
   * write in this resource. As of this writing, no currently issued
   * credential (member session, owner token, agent, or API key) carries
   * `raw:admin` anywhere in the codebase, so this will 403 with
   * `auth_scope_insufficient` until that's provisioned, the same
   * scope-provisioning gap pattern documented for `audit:write` and
   * `canonical:read` elsewhere in this project. Writes a tombstone record;
   * the artifact is retained in storage per retention policy but becomes
   * inaccessible via the API and is filtered from all Wiki derivations.
   */
  async deleteArtifact(rawId: string): Promise<void> {
    const { error, response } = await this.http.DELETE("/raw/{raw_id}", {
      params: { path: { raw_id: rawId } },
    });
    // The 410 "already tombstoned" response is a spec-level oneOf (a bare
    // `{ raw_id, tombstoned: true }` shape, NOT the standard Error envelope),
    // BrainAPIError degrades it to code "unknown" via its `body?.error`
    // optional access, same pattern as sessions.create's bare-reason 403.
    if (error !== undefined) {
      throw new BrainAPIError(response.status, error as BrainErrorBody | undefined);
    }
  }

  /**
   * Requires `raw:write`: production member sessions don't carry this
   * (only owner/login tokens do). Records one parser-output row for the
   * artifact. Naturally idempotent on the (raw_id, parser, parser_version)
   * tuple: re-posting the same tuple returns the existing row with 200
   * instead of creating a duplicate. Never touches Ledger, that's the
   * separate normalize service's job.
   */
  async writeParsed(rawId: string, body: WriteRawParsedBody): Promise<RawParsed> {
    const { data, error, response } = await this.http.POST("/raw/{raw_id}/parsed", {
      params: { path: { raw_id: rawId } },
      body,
    });
    return unwrap(data, error, response.status);
  }

  /**
   * Requires `raw:write`. Connects a source connector for this tenant.
   * Idempotent: reconnecting the same source returns the existing record.
   * `credentials` is opaque to the SDK and encrypted server-side; never log
   * it.
   */
  async connectSource(body: ConnectSourceBody): Promise<Source> {
    const { data, error, response } = await this.http.POST("/sources", { body });
    return unwrap(data, error, response.status);
  }

  /** Requires `raw:read`. */
  async getSource(sourceId: string): Promise<Source> {
    const { data, error, response } = await this.http.GET("/sources/{source_id}", {
      params: { path: { source_id: sourceId } },
    });
    return unwrap(data, error, response.status);
  }

  /**
   * Requires `raw:write`. Marks the source disconnected; does not delete
   * previously ingested artifacts.
   */
  async disconnectSource(sourceId: string): Promise<Source> {
    const { data, error, response } = await this.http.DELETE("/sources/{source_id}", {
      params: { path: { source_id: sourceId } },
    });
    return unwrap(data, error, response.status);
  }
}

function mapExtractionJob(body: RawExtractionJob): RawExtractResult {
  return {
    jobId: body.job_id,
    rawId: body.raw_id,
    status: body.status,
    parsedId: body.parsed_id,
    confidence: body.confidence,
    error: body.error,
    nextAttemptAt: body.next_attempt_at,
    createdAt: body.created_at,
    updatedAt: body.updated_at,
  };
}

function mapSourceSyncJob(body: SourceSyncJob): SourceSyncJobResult {
  return {
    jobId: body.job_id,
    sourceId: body.source_id,
    status: body.status,
    errorMessage: body.error_message ?? null,
    notes: body.notes,
    createdAt: body.created_at,
    updatedAt: body.updated_at,
  };
}
