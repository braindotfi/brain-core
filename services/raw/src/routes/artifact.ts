/**
 * GET /raw/{raw_id}     — signed URL
 * DELETE /raw/{raw_id}  — tombstone
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { brainError, isBrainId, requireScope, withTenantScope, type Scope } from "@brain/api/shared";
import { findArtifactById, tombstoneArtifact } from "../repository/artifacts.js";
import type { RawDeps } from "../deps.js";

const READ_SCOPE: Scope = "raw:read";
const WRITE_SCOPE: Scope = "raw:admin";
const SIGNED_URL_TTL_SECONDS = 600; // 10 minutes per spec

export async function registerArtifact(app: FastifyInstance, deps: RawDeps): Promise<void> {
  app.get(
    "/raw/:raw_id",
    async (request: FastifyRequest<{ Params: { raw_id: string } }>, reply) => {
      assertPrincipal(request);
      requireScope(request.principal!.scopes, READ_SCOPE);
      const id = request.params.raw_id;
      if (!isBrainId(id, "raw")) {
        throw brainError("request_params_invalid", "malformed raw_id", {
          details: { raw_id: id },
        });
      }

      const row = await withTenantScope(deps.pool, request.principal!.tenantId, (c) =>
        findArtifactById(c, id),
      );
      if (row === null) {
        throw brainError("raw_artifact_not_found", "no such raw artifact", {
          details: { raw_id: id },
        });
      }
      if (row.tombstoned_at !== null) {
        throw brainError("raw_artifact_tombstoned", "artifact has been tombstoned", {
          statusOverride: 410,
          details: { raw_id: id },
        });
      }

      const url = await deps.blob.signedUrl(row.blob_uri, {
        expiresInSeconds: SIGNED_URL_TTL_SECONDS,
      });
      const expiresAt = new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000).toISOString();

      reply.status(200);
      return {
        raw_id: row.id,
        sha256: row.sha256.toString("hex"),
        signed_url: url,
        expires_at: expiresAt,
        mime_type: row.mime_type,
        bytes: Number(row.bytes),
      };
    },
  );

  app.delete(
    "/raw/:raw_id",
    async (request: FastifyRequest<{ Params: { raw_id: string } }>, reply) => {
      assertPrincipal(request);
      requireScope(request.principal!.scopes, WRITE_SCOPE);
      const id = request.params.raw_id;
      if (!isBrainId(id, "raw")) {
        throw brainError("request_params_invalid", "malformed raw_id");
      }

      const outcome = await withTenantScope(deps.pool, request.principal!.tenantId, (c) =>
        tombstoneArtifact(c, id),
      );
      if (outcome.notFound) {
        throw brainError("raw_artifact_not_found", "no such raw artifact", {
          details: { raw_id: id },
        });
      }
      if (outcome.alreadyTombstoned) {
        reply.status(410);
        return { raw_id: id, tombstoned: true };
      }

      // Tombstone flag in blob metadata too; does not delete bytes.
      try {
        const existing = await withTenantScope(
          deps.pool,
          request.principal!.tenantId,
          (c) => findArtifactById(c, id),
        );
        if (existing !== null) {
          await deps.blob.tombstone(existing.blob_uri, request.principal!.id);
        }
      } catch {
        /* blob tombstone is best-effort; row tombstone is authoritative */
      }

      await deps.audit.emit({
        tenantId: request.principal!.tenantId,
        layer: "raw",
        actor: request.principal!.id,
        action: "raw.tombstone",
        inputs: { raw_id: id },
        outputs: {},
      });

      reply.status(204);
      return null;
    },
  );
}

function assertPrincipal(request: FastifyRequest): void {
  if (request.principal === undefined) {
    throw brainError("auth_token_missing", "principal required");
  }
}
