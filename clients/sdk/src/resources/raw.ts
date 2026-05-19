import type { BrainHttpClient } from "../client.js";
import { BrainAPIError, type BrainErrorBody } from "../errors.js";
import type { components, paths } from "../generated/openapi.js";

type RawIngestResponse = components["schemas"]["RawIngestResponse"];
type RawSourceType = components["schemas"]["RawSourceType"];
type RawParsed = components["schemas"]["RawParsed"];

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

export type GetParsedParams = NonNullable<
  paths["/raw/{raw_id}/parsed"]["get"]["parameters"]["query"]
>;

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
}
