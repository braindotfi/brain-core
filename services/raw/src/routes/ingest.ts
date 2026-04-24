/**
 * POST /raw/ingest
 *
 * Two content types:
 *   - multipart/form-data with { source_type, source_ref?, file, mime_type? }
 *   - application/json    with { source_type, source_ref?, url, auth_header? }
 *
 * Responses:
 *   201 new artifact
 *   200 existing artifact (content-addressed dedup)
 *
 * Idempotent by sha256 of the body — dedup is intrinsic, no Idempotency-Key
 * header needed (§5.1 "naturally idempotent").
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { brainError, isBrainId, requireScope, type Scope } from "@brain/api/shared";
import { adapterForSourceType } from "../adapters/registry.js";
import { ingestOne } from "../services/ingest.js";
import type { RawDeps } from "../deps.js";

const REQUIRED_SCOPE: Scope = "raw:write";
const MAX_BYTES = 50 * 1024 * 1024; // §table row 413

interface JsonBody {
  source_type?: string;
  source_ref?: Record<string, unknown>;
  url?: string;
  auth_header?: string;
}

export async function registerIngest(app: FastifyInstance, deps: RawDeps): Promise<void> {
  app.post("/raw/ingest", async (request, reply) => {
    assertPrincipal(request);
    requireScope(request.principal!.scopes, REQUIRED_SCOPE);

    const contentType = request.headers["content-type"] ?? "";
    if (contentType.startsWith("multipart/form-data")) {
      return handleMultipart(request, reply, deps);
    }
    if (contentType.startsWith("application/json")) {
      return handleJson(request, reply, deps);
    }
    throw brainError("request_body_invalid", "unsupported content-type for /raw/ingest", {
      details: { contentType },
    });
  });
}

function assertPrincipal(request: FastifyRequest): void {
  if (request.principal === undefined) {
    throw brainError("auth_token_missing", "principal required");
  }
  if (!isBrainId(request.principal.tenantId, "tnt")) {
    throw brainError("auth_tenant_mismatch", "principal tenantId malformed");
  }
}

async function handleMultipart(
  request: FastifyRequest,
  reply: import("fastify").FastifyReply,
  deps: RawDeps,
) {
  // @fastify/multipart registered on the server; request.parts() yields parts.
  // Collect into a {fieldname → value|file}. A single file field named "file"
  // is required; form fields are captured as strings.
  const anyRequest = request as unknown as {
    parts: () => AsyncIterable<
      | { type: "field"; fieldname: string; value: unknown }
      | {
          type: "file";
          fieldname: string;
          filename: string;
          mimetype: string;
          toBuffer: () => Promise<Buffer>;
        }
    >;
  };
  let source_type: string | undefined;
  let source_ref: Record<string, unknown> | undefined;
  let mime_type: string | undefined;
  let file: { body: Buffer; mime: string; name: string } | undefined;

  for await (const part of anyRequest.parts()) {
    if (part.type === "field") {
      if (part.fieldname === "source_type") source_type = String(part.value);
      else if (part.fieldname === "source_ref") {
        try {
          source_ref =
            typeof part.value === "string"
              ? (JSON.parse(part.value) as Record<string, unknown>)
              : (part.value as Record<string, unknown>);
        } catch {
          throw brainError("request_body_invalid", "source_ref must be JSON");
        }
      } else if (part.fieldname === "mime_type") mime_type = String(part.value);
    } else {
      if (part.fieldname !== "file") continue;
      const body = await part.toBuffer();
      if (body.length > MAX_BYTES) {
        throw brainError("request_too_large", "artifact exceeds 50MB ingestion cap");
      }
      file = { body, mime: part.mimetype, name: part.filename };
    }
  }

  if (source_type === undefined || file === undefined) {
    throw brainError("request_body_invalid", "source_type and file are required");
  }
  // Validate via the adapter registry — unknown source_type returns the
  // canonical raw_source_unsupported error.
  adapterForSourceType(source_type);

  const result = await ingestOne(deps, {
    tenantId: request.principal!.tenantId,
    actor: request.principal!.id,
    sourceType: source_type,
    sourceRef: source_ref ?? {},
    body: file.body,
    mimeType: mime_type ?? file.mime,
  });

  reply.status(result.deduplicated ? 200 : 201);
  return {
    raw_id: result.rawId,
    sha256: result.sha256,
    source_type: result.sourceType,
    bytes: result.bytes,
    ingested_at: result.ingestedAt,
    deduplicated: result.deduplicated,
  };
}

async function handleJson(
  request: FastifyRequest,
  reply: import("fastify").FastifyReply,
  deps: RawDeps,
) {
  const body = (request.body ?? {}) as JsonBody;
  if (body.source_type === undefined || body.url === undefined) {
    throw brainError("request_body_invalid", "source_type and url are required");
  }
  if (!body.url.startsWith("https://")) {
    throw brainError("request_body_invalid", "url must be HTTPS");
  }
  adapterForSourceType(body.source_type);

  const headers: Record<string, string> = {};
  if (body.auth_header !== undefined) headers["authorization"] = body.auth_header;

  const res = await fetch(body.url, { headers });
  if (!res.ok) {
    throw brainError("dependency_unavailable", `fetch failed: HTTP ${res.status}`, {
      details: { status: res.status },
    });
  }
  const arrayBuf = await res.arrayBuffer();
  if (arrayBuf.byteLength > MAX_BYTES) {
    throw brainError("request_too_large", "fetched artifact exceeds 50MB cap");
  }

  const result = await ingestOne(deps, {
    tenantId: request.principal!.tenantId,
    actor: request.principal!.id,
    sourceType: body.source_type,
    sourceRef: body.source_ref ?? { url: body.url },
    body: Buffer.from(arrayBuf),
    mimeType: res.headers.get("content-type") ?? undefined,
  });

  reply.status(result.deduplicated ? 200 : 201);
  return {
    raw_id: result.rawId,
    sha256: result.sha256,
    source_type: result.sourceType,
    bytes: result.bytes,
    ingested_at: result.ingestedAt,
    deduplicated: result.deduplicated,
  };
}
