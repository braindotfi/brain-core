import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { brainError, isBrainId, requireScope, withTenantScope, type Scope } from "@brain/shared";
import {
  enqueueExtractionJob,
  extractionJobToWire,
  findArtifactById,
  findLatestExtractionJob,
} from "@brain/raw";

const WRITE: Scope = "raw:write";
const READ: Scope = "raw:read";

export interface RegisterRawExtractRouteDeps {
  pool: Pool;
}

export async function registerRawExtractRoute(
  app: FastifyInstance,
  deps: RegisterRawExtractRouteDeps,
): Promise<void> {
  app.post(
    "/raw/:raw_id/extract",
    async (request: FastifyRequest<{ Params: { raw_id: string } }>) => {
      const principal = request.principal;
      if (principal === undefined) {
        throw brainError("auth_token_missing", "principal required");
      }
      requireScope(principal.scopes, WRITE);
      if (!isBrainId(request.params.raw_id, "raw")) {
        throw brainError("request_params_invalid", "malformed raw_id");
      }

      const job = await withTenantScope(deps.pool, principal.tenantId, async (c) => {
        const artifact = await findArtifactById(c, request.params.raw_id);
        if (artifact === null) {
          throw brainError("raw_artifact_not_found", "raw artifact not found", {
            statusOverride: 404,
          });
        }
        if (artifact.tombstoned_at !== null) {
          throw brainError("raw_artifact_tombstoned", "raw artifact has been tombstoned", {
            statusOverride: 410,
          });
        }
        const enqueued = await enqueueExtractionJob(c, {
          tenantId: principal.tenantId,
          rawId: artifact.id,
          contentSha256: artifact.sha256,
          requestedBy: principal.id,
        });
        return enqueued.row;
      });
      return extractionJobToWire(job);
    },
  );

  app.get(
    "/raw/:raw_id/extraction",
    async (request: FastifyRequest<{ Params: { raw_id: string } }>) => {
      const principal = request.principal;
      if (principal === undefined) {
        throw brainError("auth_token_missing", "principal required");
      }
      requireScope(principal.scopes, READ);
      if (!isBrainId(request.params.raw_id, "raw")) {
        throw brainError("request_params_invalid", "malformed raw_id");
      }

      const job = await withTenantScope(deps.pool, principal.tenantId, async (c) => {
        const artifact = await findArtifactById(c, request.params.raw_id);
        if (artifact === null) {
          throw brainError("raw_artifact_not_found", "raw artifact not found", {
            statusOverride: 404,
          });
        }
        const latest = await findLatestExtractionJob(c, request.params.raw_id);
        if (latest === null) {
          throw brainError("extraction_job_not_found", "extraction job not found", {
            statusOverride: 404,
          });
        }
        return latest;
      });
      return extractionJobToWire(job);
    },
  );
}
