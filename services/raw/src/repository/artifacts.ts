/**
 * raw_artifacts repository. Tenant-scoped by the shared withTenantScope()
 * helper — never takes `tenantId` in a WHERE clause (see §1 principle 2).
 */

import type { TenantScopedClient } from "@brain/shared";

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
}

/**
 * Insert a new artifact. If (tenant_id, sha256) collides, returns the
 * existing row's id via ON CONFLICT — this is the dedup path §3 Layer 1
 * requires. Caller checks `deduplicated` by comparing inserted.id to the
 * requested id.
 */
export async function insertOrReuseArtifact(
  client: TenantScopedClient,
  input: InsertArtifactInput,
): Promise<{ row: RawArtifactRow; deduplicated: boolean }> {
  const sha = Buffer.from(input.sha256Hex, "hex");
  const { rows } = await client.query<RawArtifactRow>(
    `INSERT INTO raw_artifacts
       (id, tenant_id, sha256, source_type, source_ref, blob_uri, mime_type, bytes, ingested_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
    ],
  );
  const row = rows[0];
  if (row === undefined) throw new Error("raw_artifacts insert returned no row");
  return { row, deduplicated: row.id !== input.id };
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
