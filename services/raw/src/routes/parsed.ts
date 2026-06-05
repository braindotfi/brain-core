/**
 * GET  /raw/{raw_id}/parsed  — list parser outputs (stage-2 returns []).
 * POST /raw/{raw_id}/parsed  — write one parser output (the stage-3 producer).
 *
 * The POST is the first writer of raw_parsed in the system. It is called by
 * extraction workers and first-party extractor agents (e.g. document_extractor)
 * and is the boundary-clean way for an agent to contribute parsed evidence:
 * Raw owns the table, the agent calls the API, and writing into Ledger stays
 * the Ledger normalize service's job. The write never touches Ledger.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  brainError,
  isBrainId,
  newRawParsedId,
  requireScope,
  sha256Hex,
  withTenantScope,
  type Scope,
} from "@brain/shared";
import { findArtifactById } from "../repository/artifacts.js";
import { insertParsed, listParsedByArtifact, type RawParsedRow } from "../repository/parsed.js";
import type { RawDeps } from "../deps.js";

const READ_SCOPE: Scope = "raw:read";
const WRITE_SCOPE: Scope = "raw:write";

export interface RawParsedWriteBody {
  parser: string;
  parser_version: string;
  extracted: Record<string, unknown>;
  confidence: number | null;
}

/**
 * Validate and normalize a POST body. Pure (no IO) so it is unit-testable
 * without a database. Throws a 400 brainError on any shape violation.
 */
export function parseRawParsedWriteBody(raw: unknown): RawParsedWriteBody {
  if (typeof raw !== "object" || raw === null) {
    throw brainError("request_body_invalid", "body must be a JSON object");
  }
  const body = raw as Record<string, unknown>;

  const parser = body["parser"];
  if (typeof parser !== "string" || parser.length === 0 || parser.length > 128) {
    throw brainError("request_body_invalid", "parser must be a non-empty string (<=128 chars)");
  }
  const parserVersion = body["parser_version"];
  if (
    typeof parserVersion !== "string" ||
    parserVersion.length === 0 ||
    parserVersion.length > 64
  ) {
    throw brainError(
      "request_body_invalid",
      "parser_version must be a non-empty string (<=64 chars)",
    );
  }
  const extracted = body["extracted"];
  if (typeof extracted !== "object" || extracted === null || Array.isArray(extracted)) {
    throw brainError("request_body_invalid", "extracted must be a JSON object");
  }

  let confidence: number | null = null;
  const rawConfidence = body["confidence"];
  if (rawConfidence !== undefined && rawConfidence !== null) {
    if (typeof rawConfidence !== "number" || rawConfidence < 0 || rawConfidence > 1) {
      throw brainError("request_body_invalid", "confidence must be a number in [0, 1]");
    }
    confidence = rawConfidence;
  }

  return {
    parser,
    parser_version: parserVersion,
    extracted: extracted as Record<string, unknown>,
    confidence,
  };
}

function serializeParsed(p: RawParsedRow): Record<string, unknown> {
  return {
    id: p.id,
    raw_artifact_id: p.raw_artifact_id,
    parser: p.parser,
    parser_version: p.parser_version,
    extracted: p.extracted,
    confidence: p.confidence,
    extracted_at: p.extracted_at.toISOString(),
  };
}

export async function registerParsed(app: FastifyInstance, deps: RawDeps): Promise<void> {
  app.get(
    "/raw/:raw_id/parsed",
    async (
      request: FastifyRequest<{
        Params: { raw_id: string };
        Querystring: { parser?: string; parser_version?: string };
      }>,
      reply,
    ) => {
      if (request.principal === undefined) {
        throw brainError("auth_token_missing", "principal required");
      }
      requireScope(request.principal.scopes, READ_SCOPE);

      const id = request.params.raw_id;
      if (!isBrainId(id, "raw")) {
        throw brainError("request_params_invalid", "malformed raw_id");
      }

      const result = await withTenantScope(deps.pool, request.principal.tenantId, async (c) => {
        const artifact = await findArtifactById(c, id);
        if (artifact === null) return null;
        const parsed = await listParsedByArtifact(c, id, {
          ...(request.query.parser !== undefined ? { parser: request.query.parser } : {}),
          ...(request.query.parser_version !== undefined
            ? { parserVersion: request.query.parser_version }
            : {}),
        });
        return { artifact, parsed };
      });

      if (result === null) {
        throw brainError("raw_artifact_not_found", "no such raw artifact");
      }

      reply.status(200);
      return {
        raw_id: result.artifact.id,
        parsed: result.parsed.map(serializeParsed),
      };
    },
  );

  app.post(
    "/raw/:raw_id/parsed",
    async (request: FastifyRequest<{ Params: { raw_id: string }; Body: unknown }>, reply) => {
      if (request.principal === undefined) {
        throw brainError("auth_token_missing", "principal required");
      }
      requireScope(request.principal.scopes, WRITE_SCOPE);

      const id = request.params.raw_id;
      if (!isBrainId(id, "raw")) {
        throw brainError("request_params_invalid", "malformed raw_id");
      }

      const body = parseRawParsedWriteBody(request.body);
      const tenantId = request.principal.tenantId;
      const actor = request.principal.id;

      const result = await withTenantScope(deps.pool, tenantId, async (c) => {
        const artifact = await findArtifactById(c, id);
        if (artifact === null) return { kind: "not_found" as const };
        if (artifact.tombstoned_at !== null) return { kind: "tombstoned" as const };
        const { row, created } = await insertParsed(c, {
          id: newRawParsedId(),
          rawArtifactId: id,
          tenantId,
          parser: body.parser,
          parserVersion: body.parser_version,
          extracted: body.extracted,
          confidence: body.confidence,
        });
        return { kind: "ok" as const, row, created };
      });

      if (result.kind === "not_found") {
        throw brainError("raw_artifact_not_found", "no such raw artifact");
      }
      if (result.kind === "tombstoned") {
        throw brainError("raw_artifact_tombstoned", "artifact has been tombstoned", {
          statusOverride: 410,
        });
      }

      // Audit — §1 principle 4. `extracted` may carry PII, so the log body
      // records only identifiers + a content hash of the payload (§6.1).
      await deps.audit.emit({
        tenantId,
        layer: "raw",
        actor,
        action: result.created ? "raw.parsed.write" : "raw.parsed.deduplicated",
        inputs: {
          raw_id: id,
          parser: body.parser,
          parser_version: body.parser_version,
          extracted_sha256: sha256Hex(Buffer.from(JSON.stringify(body.extracted))),
        },
        outputs: {
          parsed_id: result.row.id,
          created: result.created,
        },
      });

      reply.status(result.created ? 201 : 200);
      return serializeParsed(result.row);
    },
  );
}
