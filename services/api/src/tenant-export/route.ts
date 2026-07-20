import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { brainError, isBrainId, withTenantScope, type BlobAdapter } from "@brain/shared";
import {
  enqueueTenantExportJob,
  findTenantExportJob,
  tenantExportJobToWire,
} from "./repository.js";
import { assertExportDownloadable } from "./service.js";

const DEFAULT_EXPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface TenantExportRouteDeps {
  pool: Pool;
  blob: BlobAdapter;
  exportTtlMs?: number;
}

export async function registerTenantExportRoute(
  app: FastifyInstance,
  deps: TenantExportRouteDeps,
): Promise<void> {
  app.post<{ Params: { id: string } }>("/tenants/:id/export", async (request, reply) => {
    const principal = requireOwnTenantUser(request, request.params.id, "tenant export");
    const expiresAt = new Date(Date.now() + (deps.exportTtlMs ?? DEFAULT_EXPORT_TTL_MS));
    const enqueued = await withTenantScope(deps.pool, request.params.id, (client) =>
      enqueueTenantExportJob(client, {
        tenantId: request.params.id,
        requestedBy: principal.id,
        expiresAt,
      }),
    );
    reply.status(enqueued.created ? 202 : 200);
    return tenantExportJobToWire(enqueued.row);
  });

  app.get<{ Params: { id: string; job_id: string } }>(
    "/tenants/:id/export/:job_id",
    async (request) => {
      requireOwnTenantUser(request, request.params.id, "tenant export status");
      const job = await loadJob(deps.pool, request.params.id, request.params.job_id);
      return tenantExportJobToWire(job);
    },
  );

  app.get<{ Params: { id: string; job_id: string } }>(
    "/tenants/:id/export/:job_id/download",
    async (request, reply) => {
      requireOwnTenantUser(request, request.params.id, "tenant export download");
      const job = await loadJob(deps.pool, request.params.id, request.params.job_id);
      assertExportDownloadable(job, new Date());
      const stream = await deps.blob.get(job.output_blob_uri!);
      reply.header("content-type", "application/x-ndjson");
      reply.header("content-disposition", `attachment; filename="${job.id}.ndjson"`);
      return reply.send(stream);
    },
  );
}

function requireOwnTenantUser(
  request: FastifyRequest,
  targetTenantId: string,
  purpose: string,
): NonNullable<FastifyRequest["principal"]> {
  if (request.principal === undefined) {
    throw brainError("auth_token_missing", "principal required");
  }
  if (request.principal.type !== "user") {
    throw brainError("auth_scope_insufficient", `${purpose} requires principal_type=user`);
  }
  if (request.principal.tenantId !== targetTenantId) {
    throw brainError("auth_tenant_mismatch", `${purpose} is self-only`, {
      details: { principal_tenant: request.principal.tenantId, target_tenant: targetTenantId },
    });
  }
  return request.principal;
}

async function loadJob(pool: Pool, tenantId: string, jobId: string) {
  if (!isBrainId(jobId, "texp")) {
    throw brainError("request_params_invalid", "malformed tenant export job id");
  }
  const job = await withTenantScope(pool, tenantId, (client) => findTenantExportJob(client, jobId));
  if (job === null) {
    throw brainError("tenant_export_job_not_found", "tenant export job not found", {
      statusOverride: 404,
    });
  }
  return job;
}
