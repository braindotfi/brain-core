/**
 * Raw ingestion orchestrator.
 *
 * Central path: bytes in → content-address → dedup check → blob write →
 * artifact row insert → audit emit → response. Shared between the
 * /raw/ingest endpoint and the /raw/webhooks/* fan-out.
 */

import {
  blobPath,
  newRawArtifactId,
  sha256Hex,
  withTenantScope,
  type AuditEmitter,
  type BlobAdapter,
} from "@brain/shared";
import type { Pool } from "pg";
import { insertOrReuseArtifact } from "../repository/artifacts.js";
import type { IngestEnvelopeFields } from "../envelope.js";

export interface IngestInput {
  tenantId: string;
  actor: string; // principal id
  sourceType: string;
  sourceRef: Record<string, unknown>;
  body: Buffer;
  mimeType: string | undefined;
  /**
   * Standard ingestion envelope (§9). Declared metadata over an opaque
   * payload — intake stores it and never parses the bytes against it, so an
   * unknown sourceSchema still ingests and waits for a parser.
   */
  envelope?: IngestEnvelopeFields;
}

export interface IngestResult {
  rawId: string;
  sha256: string;
  bytes: number;
  sourceType: string;
  sourceSchema: string | null;
  ingestedAt: string;
  deduplicated: boolean;
}

export interface IngestDeps {
  pool: Pool;
  blob: BlobAdapter;
  audit: AuditEmitter;
}

export async function ingestOne(deps: IngestDeps, input: IngestInput): Promise<IngestResult> {
  const sha = sha256Hex(input.body);
  const id = newRawArtifactId();
  const path = blobPath(input.tenantId, sha);

  // Upload bytes with immutable flag (§3 Layer 1 immutability).
  await deps.blob.put(path, input.body, {
    ...(input.mimeType !== undefined ? { contentType: input.mimeType } : {}),
    immutable: true,
    metadata: {
      source_type: input.sourceType,
      tenant_id: input.tenantId,
      sha256: sha,
    },
  });

  // Insert-or-reuse inside a tenant-scoped TX.
  const { row, deduplicated } = await withTenantScope(deps.pool, input.tenantId, async (client) =>
    insertOrReuseArtifact(client, {
      id,
      tenantId: input.tenantId,
      sha256Hex: sha,
      sourceType: input.sourceType,
      sourceRef: input.sourceRef,
      blobUri: path,
      mimeType: input.mimeType,
      bytes: input.body.length,
      ingestedBy: input.actor,
      ...(input.envelope !== undefined ? { envelope: input.envelope } : {}),
    }),
  );

  // Audit emit — §1 principle 4. Inputs/outputs are hashes and identifiers
  // only; §6.1 forbids PII in log bodies and the audit store is a log.
  await deps.audit.emit({
    tenantId: input.tenantId,
    layer: "raw",
    actor: input.actor,
    action: deduplicated ? "raw.ingest.deduplicated" : "raw.ingest.new",
    inputs: {
      source_type: input.sourceType,
      sha256: sha,
      bytes: input.body.length,
      ...(input.envelope?.sourceSchema !== undefined
        ? { source_schema: input.envelope.sourceSchema }
        : {}),
      ...(input.envelope?.objectType !== undefined
        ? { object_type: input.envelope.objectType }
        : {}),
    },
    outputs: {
      raw_id: row.id,
      deduplicated,
    },
  });

  return {
    rawId: row.id,
    sha256: sha,
    bytes: Number(row.bytes),
    sourceType: row.source_type,
    sourceSchema: row.source_schema ?? null,
    ingestedAt: toIso(row.ingested_at),
    deduplicated,
  };
}

/** Fan out a webhook-produced artifact set through ingestOne. */
export async function ingestMany(
  deps: IngestDeps,
  inputs: ReadonlyArray<IngestInput>,
): Promise<IngestResult[]> {
  const out: IngestResult[] = [];
  for (const i of inputs) out.push(await ingestOne(deps, i));
  return out;
}

function toIso(d: Date | string): string {
  return typeof d === "string" ? d : d.toISOString();
}
