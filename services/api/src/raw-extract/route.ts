import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import {
  brainError,
  isBrainId,
  requireScope,
  withTenantScope,
  type BlobAdapter,
  type Scope,
  type ServiceCallContext,
} from "@brain/shared";
import { findArtifactById } from "@brain/raw";
import type {
  DocumentExtractInput,
  DocumentExtractResult,
} from "../agents/documentExtractClient.js";

const WRITE: Scope = "raw:write";
const DEFAULT_MIME_TYPE = "application/octet-stream";

export interface DocumentExtractPort {
  extract(ctx: ServiceCallContext, input: DocumentExtractInput): Promise<DocumentExtractResult>;
}

export interface RegisterRawExtractRouteDeps {
  pool: Pool;
  blob: BlobAdapter;
  client?: DocumentExtractPort;
  agentId: string;
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string | Uint8Array));
  }
  return Buffer.concat(chunks);
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
      if (deps.client === undefined) {
        throw brainError("dependency_unavailable", "document extraction agent is not configured", {
          statusOverride: 501,
        });
      }

      const artifact = await withTenantScope(deps.pool, principal.tenantId, (c) =>
        findArtifactById(c, request.params.raw_id),
      );
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

      const bytes = await readAll(await deps.blob.get(artifact.blob_uri));
      return deps.client.extract(
        {
          tenantId: principal.tenantId,
          actor: principal.id,
          principalType: principal.type,
          scopes: principal.scopes,
        },
        {
          rawId: artifact.id,
          mimeType: artifact.mime_type ?? DEFAULT_MIME_TYPE,
          documentB64: bytes.toString("base64"),
          agentId: deps.agentId,
        },
      );
    },
  );
}
