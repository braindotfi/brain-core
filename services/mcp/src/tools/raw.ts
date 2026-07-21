/**
 * Raw contribution tool — the path by which an external agent pushes
 * structured observations into Brain's evidence store.
 *
 * The artifact is content-addressed by sha256, attributed to the agent's
 * on-chain registration record, and ingested with `source_type =
 * agent_contributed`. Any Ledger rows derived from it carry
 * `provenance = agent_contributed` and start at confidence ceiling 0.5
 * per §3.2 of the architecture.
 */

import { brainError, withTenantScope, type TenantScopedClient } from "@brain/shared";
import {
  requireAgentContext,
  requireString,
  requireToolService,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "./types.js";

interface RawContributeInput {
  /** Free-form payload the agent wants to attribute to itself. */
  payload: string;
  /** MIME type of the payload (default: application/json). */
  mime_type?: string;
  /** Optional source-specific identifiers (e.g. transcript id, doc id). */
  source_ref?: Record<string, unknown>;
}

interface RawArtifactGetInput {
  raw_id: string;
  include_parsed: boolean;
}

interface RawArtifactRow {
  id: string;
  sha256: Buffer | string;
  source_type: string;
  source_ref: Record<string, unknown>;
  mime_type: string | null;
  bytes: string | number;
  ingested_at: Date | string;
  tombstoned_at: Date | string | null;
  ingested_by: string;
  source_schema: string | null;
  object_type: string | null;
  external_id: string | null;
  operation: string | null;
  effective_at: Date | string | null;
  observed_at: Date | string | null;
  original_source: string | null;
  intermediaries: string[] | null;
  source_id: string | null;
  source_version: string | null;
  idempotency_key: string | null;
}

interface RawParsedRow {
  id: string;
  parser: string;
  parser_version: string;
  extracted: Record<string, unknown>;
  confidence: number | null;
  extracted_at: Date | string;
}

export const rawContributeTool: Tool<RawContributeInput> = {
  name: "raw.contribute",
  description:
    "Submit a raw artifact attributed to this agent. Returns the raw_id once stored. Subsequent extractions into the Ledger will carry provenance=agent_contributed and confidence ≤ 0.5.",
  requiredScopes: ["raw:write"],
  inputSchema: {
    type: "object",
    required: ["payload"],
    properties: {
      payload: {
        type: "string",
        description: "Artifact bytes as a string. JSON, text, or base64-encoded binary.",
      },
      mime_type: { type: "string", default: "application/json" },
      source_ref: { type: "object", additionalProperties: true },
    },
  },
  parseInput(params): RawContributeInput {
    const payload = requireString(params, "payload");
    const out: RawContributeInput = { payload };
    if (typeof params.mime_type === "string") out.mime_type = params.mime_type;
    if (
      typeof params.source_ref === "object" &&
      params.source_ref !== null &&
      !Array.isArray(params.source_ref)
    ) {
      out.source_ref = params.source_ref as Record<string, unknown>;
    }
    return out;
  },
  async handle(ctx: ToolContext, input): Promise<ToolResult> {
    const agent = requireAgentContext(ctx, "raw.contribute");
    const body = Buffer.from(input.payload, "utf8");
    const result = await ctx.raw.ingest(ctx.ctx, {
      sourceType: "agent_contributed",
      sourceRef: {
        agent_id: agent.id,
        agent_role: agent.role,
        ...(input.source_ref ?? {}),
      },
      body,
      ...(input.mime_type !== undefined ? { mimeType: input.mime_type } : {}),
    });
    return {
      payload: result,
      summary:
        `Raw artifact stored as \`${result.rawId}\`.\n` +
        `sha256: \`${result.sha256}\`\n` +
        `bytes: ${result.bytes}\n` +
        `deduplicated: ${result.deduplicated ? "yes (existing artifact returned)" : "no"}\n\n` +
        `Any Ledger entities derived from this artifact will be tagged ` +
        `\`provenance=agent_contributed\` with confidence ≤ 0.5.`,
    };
  },
};

export const rawArtifactGetTool: Tool<RawArtifactGetInput> = {
  name: "raw.artifact.get",
  description:
    "Read one tenant-scoped raw artifact's provenance metadata and parsed evidence. Does not return blob_uri or mint signed URLs.",
  requiredScopes: ["raw:read"],
  inputSchema: {
    type: "object",
    required: ["raw_id"],
    properties: {
      raw_id: { type: "string", description: "Brain raw artifact id." },
      include_parsed: {
        type: "boolean",
        default: true,
        description: "Include parser outputs for the artifact.",
      },
    },
  },
  parseInput(params): RawArtifactGetInput {
    const includeParsed =
      params.include_parsed === undefined ? true : requireBoolean(params, "include_parsed");
    return {
      raw_id: requireString(params, "raw_id"),
      include_parsed: includeParsed,
    };
  },
  async handle(ctx: ToolContext, input): Promise<ToolResult> {
    const readerPool = requireToolService(ctx.rawReaderPool, "raw.artifact.get");
    const result = await withTenantScope(readerPool, ctx.ctx.tenantId, async (client) =>
      readRawArtifact(client, input),
    );
    if (result === null) {
      throw brainError("raw_artifact_not_found", "no such raw artifact", {
        details: { raw_id: input.raw_id },
      });
    }
    return {
      payload: result,
      summary:
        `Raw artifact \`${result.raw_id}\` found.\n` +
        `sha256: \`${result.sha256}\`\n` +
        `bytes: ${result.bytes}\n` +
        `parsed rows: ${result.parsed.length}`,
    };
  },
};

async function readRawArtifact(
  client: TenantScopedClient,
  input: RawArtifactGetInput,
): Promise<
  | (ReturnType<typeof serializeArtifact> & {
      parsed: ReturnType<typeof serializeParsedRow>[];
    })
  | null
> {
  const { rows } = await client.query<RawArtifactRow>(
    `SELECT
       id, sha256, source_type, source_ref, mime_type, bytes,
       ingested_at, tombstoned_at, ingested_by, source_schema, object_type,
       external_id, operation, effective_at, observed_at, original_source,
       intermediaries, source_id, source_version, idempotency_key
     FROM raw_artifacts
     WHERE id = $1
     LIMIT 1`,
    [input.raw_id],
  );
  const artifact = rows[0];
  if (artifact === undefined) return null;
  const parsed = input.include_parsed
    ? (
        await client.query<RawParsedRow>(
          `SELECT
             id, parser, parser_version, extracted, confidence, extracted_at
           FROM raw_parsed
           WHERE raw_artifact_id = $1
           ORDER BY extracted_at DESC`,
          [input.raw_id],
        )
      ).rows.map(serializeParsedRow)
    : [];
  return { ...serializeArtifact(artifact), parsed };
}

function serializeArtifact(row: RawArtifactRow) {
  return {
    raw_id: row.id,
    sha256: Buffer.isBuffer(row.sha256) ? row.sha256.toString("hex") : row.sha256,
    source_type: row.source_type,
    source_ref: row.source_ref,
    mime_type: row.mime_type,
    bytes: Number(row.bytes),
    ingested_at: iso(row.ingested_at),
    tombstoned_at: row.tombstoned_at === null ? null : iso(row.tombstoned_at),
    ingested_by: row.ingested_by,
    source_schema: row.source_schema,
    object_type: row.object_type,
    external_id: row.external_id,
    operation: row.operation,
    effective_at: row.effective_at === null ? null : iso(row.effective_at),
    observed_at: row.observed_at === null ? null : iso(row.observed_at),
    original_source: row.original_source,
    intermediaries: row.intermediaries,
    source_id: row.source_id,
    source_version: row.source_version,
    idempotency_key: row.idempotency_key,
  };
}

function serializeParsedRow(row: RawParsedRow) {
  return {
    id: row.id,
    parser: row.parser,
    parser_version: row.parser_version,
    extracted: row.extracted,
    confidence: row.confidence,
    extracted_at: iso(row.extracted_at),
  };
}

function requireBoolean(params: Record<string, unknown>, name: string): boolean {
  const v = params[name];
  if (typeof v !== "boolean") {
    throw {
      code: "request_params_invalid",
      message: `'${name}' must be boolean`,
      details: { field: name },
    };
  }
  return v;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

export const rawTools: Tool[] = [
  rawArtifactGetTool as unknown as Tool,
  rawContributeTool as unknown as Tool,
];
