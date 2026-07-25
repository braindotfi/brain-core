import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { brainError, isBrainId, requireScope, withTenantScope, type Scope } from "@brain/shared";
import {
  enqueueExtractionJob,
  extractionJobToWire,
  findArtifactById,
  findLatestExtractionJob,
  type ExtractionJobRow,
} from "@brain/raw";

const WRITE: Scope = "raw:write";
const READ: Scope = "raw:read";

export interface RegisterRawExtractRouteDeps {
  pool: Pool;
  afterEnqueue?: (job: ExtractionJobRow) => Promise<void>;
}

export async function registerRawExtractRoute(
  app: FastifyInstance,
  deps: RegisterRawExtractRouteDeps,
): Promise<void> {
  app.post(
    "/raw/:raw_id/extract",
    async (request: FastifyRequest<{ Params: { raw_id: string } }>, reply: FastifyReply) => {
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
      if (deps.afterEnqueue === undefined) {
        reply.status(job.status === "queued" || job.status === "running" ? 202 : 200);
        return extractionJobToWire(job);
      }

      await deps.afterEnqueue(job);
      const latest = await withTenantScope(deps.pool, principal.tenantId, async (c) =>
        findLatestExtractionJob(c, request.params.raw_id),
      );
      const responseJob = latest ?? job;
      assertExtractionJobIsHonest(responseJob);
      reply.status(responseJob.status === "queued" || responseJob.status === "running" ? 202 : 200);
      return extractionJobToWire(responseJob);
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

function assertExtractionJobIsHonest(job: ExtractionJobRow): void {
  if (job.status === "failed") {
    const error = job.error ?? {};
    const message =
      typeof error["message"] === "string" && error["message"].length > 0
        ? error["message"]
        : "document extraction failed";
    throw brainError("dependency_unavailable", message, {
      statusOverride: 502,
      details: { job_id: job.id, raw_id: job.raw_id, error },
    });
  }
  if (job.status === "succeeded" && job.parsed_id === null) {
    throw brainError(
      "internal_server_error",
      "document extraction succeeded without parsed output",
      {
        details: { job_id: job.id, raw_id: job.raw_id },
      },
    );
  }
}
