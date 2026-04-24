/**
 * GET /raw/{raw_id}/parsed
 *
 * Returns the list of parser outputs. Stage-2 always returns []; stage-3
 * extractors populate the rows.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { brainError, isBrainId, requireScope, withTenantScope, type Scope } from "@brain/api/shared";
import { findArtifactById } from "../repository/artifacts.js";
import { listParsedByArtifact } from "../repository/parsed.js";
import type { RawDeps } from "../deps.js";

const READ_SCOPE: Scope = "raw:read";

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
        parsed: result.parsed.map((p) => ({
          id: p.id,
          raw_artifact_id: p.raw_artifact_id,
          parser: p.parser,
          parser_version: p.parser_version,
          extracted: p.extracted,
          confidence: p.confidence,
          extracted_at: p.extracted_at.toISOString(),
        })),
      };
    },
  );
}
