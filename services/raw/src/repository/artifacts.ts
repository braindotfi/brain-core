/**
 * raw_artifacts repository. Tenant-scoped by the shared withTenantScope()
 * helper — never takes `tenantId` in a WHERE clause (see §1 principle 2).
 */

import type { TenantScopedClient } from "@brain/shared";
import type { IngestEnvelopeFields } from "../envelope.js";

export interface RawArtifactRow {
  id: string;
  tenant_id: string;
  sha256: Buffer;
  source_type: string;
  source_ref: Record<string, unknown>;
  blob_uri: string;
  mime_type: string | null;
  bytes: string; // pg returns bigint as string
  ingested_at: Date;
  tombstoned_at: Date | null;
  ingested_by: string;
  // Standard ingestion envelope (raw/0008) — all nullable, declared at intake.
  source_schema: string | null;
  object_type: string | null;
  external_id: string | null;
  operation: string | null;
  effective_at: Date | null;
  observed_at: Date | null;
  original_source: string | null;
  intermediaries: string[] | null;
  source_id: string | null;
  source_version: string | null;
  idempotency_key: string | null;
}

export interface InsertArtifactInput {
  id: string;
  tenantId: string;
  sha256Hex: string;
  sourceType: string;
  sourceRef: Record<string, unknown>;
  blobUri: string;
  mimeType: string | undefined;
  bytes: number;
  ingestedBy: string;
  envelope?: IngestEnvelopeFields;
}

/** Postgres unique_violation. */
const UNIQUE_VIOLATION = "23505";

/**
 * Insert a new artifact. Two dedup guards, checked in order:
 *  1. envelope idempotency_key — the caller-declared
 *     connection:resource:object:version key (partial unique index). A
 *     provider re-send with cosmetically different bytes still dedups here.
 *  2. (tenant_id, sha256) content address — §3 Layer 1 dedup via ON CONFLICT.
 *
 * Caller checks `deduplicated` by comparing inserted.id to the requested id.
 */
export async function insertOrReuseArtifact(
  client: TenantScopedClient,
  input: InsertArtifactInput,
): Promise<{ row: RawArtifactRow; deduplicated: boolean }> {
  const sha = Buffer.from(input.sha256Hex, "hex");
  const env = input.envelope ?? {};

  if (env.idempotencyKey !== undefined) {
    const existing = await findArtifactByIdempotencyKey(client, env.idempotencyKey);
    if (existing !== null) return { row: existing, deduplicated: true };
  }

  try {
    const { rows } = await client.query<RawArtifactRow>(
      `INSERT INTO raw_artifacts
         (id, tenant_id, sha256, source_type, source_ref, blob_uri, mime_type, bytes, ingested_by,
          source_schema, object_type, external_id, operation, effective_at, observed_at,
          original_source, intermediaries, source_id, source_version, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
               $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
       ON CONFLICT (tenant_id, sha256) DO UPDATE SET source_ref = raw_artifacts.source_ref
       RETURNING *`,
      [
        input.id,
        input.tenantId,
        sha,
        input.sourceType,
        JSON.stringify(input.sourceRef),
        input.blobUri,
        input.mimeType ?? null,
        input.bytes,
        input.ingestedBy,
        env.sourceSchema ?? null,
        env.objectType ?? null,
        env.externalId ?? null,
        env.operation ?? null,
        env.effectiveAt ?? null,
        env.observedAt ?? null,
        env.originalSource ?? null,
        env.intermediaries !== undefined ? JSON.stringify(env.intermediaries) : null,
        env.sourceId ?? null,
        env.sourceVersion ?? null,
        env.idempotencyKey ?? null,
      ],
    );
    const row = rows[0];
    if (row === undefined) throw new Error("raw_artifacts insert returned no row");
    return { row, deduplicated: row.id !== input.id };
  } catch (err) {
    // Concurrent insert with the same idempotency_key but different bytes:
    // the partial unique index fires after our pre-check missed. Re-read the
    // winner — this is the dedup path, not an error.
    if (
      env.idempotencyKey !== undefined &&
      isUniqueViolation(err, "uq_raw_artifacts_tenant_idem")
    ) {
      const winner = await findArtifactByIdempotencyKey(client, env.idempotencyKey);
      if (winner !== null) return { row: winner, deduplicated: true };
    }
    throw err;
  }
}

function isUniqueViolation(err: unknown, constraint: string): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; constraint?: unknown };
  return e.code === UNIQUE_VIOLATION && e.constraint === constraint;
}

async function findArtifactByIdempotencyKey(
  client: TenantScopedClient,
  idempotencyKey: string,
): Promise<RawArtifactRow | null> {
  const { rows } = await client.query<RawArtifactRow>(
    `SELECT * FROM raw_artifacts WHERE idempotency_key = $1 LIMIT 1`,
    [idempotencyKey],
  );
  return rows[0] ?? null;
}

export async function findArtifactById(
  client: TenantScopedClient,
  id: string,
): Promise<RawArtifactRow | null> {
  const { rows } = await client.query<RawArtifactRow>(
    `SELECT * FROM raw_artifacts WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

/** Tombstone in place. Returns true iff the row transitioned from live → tombstoned. */
export async function tombstoneArtifact(
  client: TenantScopedClient,
  id: string,
  at: Date = new Date(),
): Promise<{ alreadyTombstoned: boolean; notFound: boolean }> {
  const existing = await findArtifactById(client, id);
  if (existing === null) return { alreadyTombstoned: false, notFound: true };
  if (existing.tombstoned_at !== null) return { alreadyTombstoned: true, notFound: false };
  await client.query(
    `UPDATE raw_artifacts SET tombstoned_at = $1 WHERE id = $2 AND tombstoned_at IS NULL`,
    [at, id],
  );
  return { alreadyTombstoned: false, notFound: false };
}
