/**
 * IRawEvidenceService adapter.
 *
 * @brain/raw exports ingestOne as a standalone function. The MCP server and
 * other callers expect the service-shaped IRawEvidenceService. This adapter
 * bridges the two by holding the raw deps in closure.
 */

import {
  brainError,
  withTenantScope,
  type IRawEvidenceService,
  type ServiceCallContext,
  type RawIngestRequest,
  type RawIngestResult,
  type ParsedOutput,
} from "@brain/shared";
import { ingestOne, findArtifactById, tombstoneArtifact, listParsedByArtifact } from "@brain/raw";
import type { RawDeps } from "@brain/raw";

export function buildRawEvidenceService(deps: RawDeps): IRawEvidenceService {
  return {
    async ingest(ctx: ServiceCallContext, req: RawIngestRequest): Promise<RawIngestResult> {
      const result = await ingestOne(deps, {
        tenantId: ctx.tenantId,
        actor: ctx.actor,
        sourceType: req.sourceType,
        sourceRef: req.sourceRef,
        body: req.body,
        mimeType: req.mimeType,
        ...(req.envelope !== undefined ? { envelope: req.envelope } : {}),
      });
      return {
        rawId: result.rawId,
        sha256: result.sha256,
        bytes: result.bytes,
        sourceType: result.sourceType,
        ingestedAt: result.ingestedAt,
        deduplicated: result.deduplicated,
      };
    },
    async signedUrl(ctx: ServiceCallContext, rawId: string, ttlSeconds: number): Promise<string> {
      const row = await withTenantScope(deps.pool, ctx.tenantId, (c) => findArtifactById(c, rawId));
      if (row === null) {
        throw brainError("raw_artifact_not_found", "no such raw artifact", {
          details: { raw_id: rawId },
        });
      }
      if (row.tombstoned_at !== null) {
        throw brainError("raw_artifact_tombstoned", "artifact has been tombstoned", {
          details: { raw_id: rawId },
        });
      }
      return deps.blob.signedUrl(row.blob_uri, { expiresInSeconds: ttlSeconds });
    },
    async listParsed(ctx: ServiceCallContext, rawId: string): Promise<ParsedOutput[]> {
      const rows = await withTenantScope(deps.pool, ctx.tenantId, (c) =>
        listParsedByArtifact(c, rawId),
      );
      return rows.map((r) => ({
        id: r.id,
        rawArtifactId: r.raw_artifact_id,
        parser: r.parser,
        parserVersion: r.parser_version,
        extracted: r.extracted,
        confidence: r.confidence,
        extractedAt: r.extracted_at.toISOString(),
      }));
    },
    async tombstone(ctx: ServiceCallContext, rawId: string): Promise<void> {
      const outcome = await withTenantScope(deps.pool, ctx.tenantId, (c) =>
        tombstoneArtifact(c, rawId),
      );
      if (outcome.notFound) {
        throw brainError("raw_artifact_not_found", "no such raw artifact", {
          details: { raw_id: rawId },
        });
      }
      if (!outcome.alreadyTombstoned) {
        // Best-effort blob metadata tombstone; the row tombstone is authoritative.
        try {
          const row = await withTenantScope(deps.pool, ctx.tenantId, (c) =>
            findArtifactById(c, rawId),
          );
          if (row !== null) {
            await deps.blob.tombstone(row.blob_uri, ctx.actor);
          }
        } catch {
          /* blob tombstone is best-effort */
        }
        await deps.audit.emit({
          tenantId: ctx.tenantId,
          layer: "raw",
          actor: ctx.actor,
          action: "raw.tombstone",
          inputs: { raw_id: rawId },
          outputs: {},
        });
      }
    },
  };
}
