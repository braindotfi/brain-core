/**
 * Postgres-backed source repository with AES-256-GCM credential encryption.
 *
 * Implements both `SourceRepository` (public interface) and
 * `SourceCredentialStore` (extended interface for execution-time secret
 * retrieval). Credential encryption uses the key supplied at construction;
 * sources with no sensitive credentials (wallets, public-key types) store
 * NULL in encrypted_credentials.
 */

import type { Pool } from "pg";
import { decryptCredentials, encryptCredentials, withTenantScope } from "@brain/shared";
import type { SourceRecord, SourceStatus, SourceSyncJobRecord, SourceType } from "./types.js";
import type {
  ListFilter,
  SourceCredentialStore,
  SourceRepository,
  SourceSyncJobRepository,
} from "./SourceService.js";

export interface PostgresSourceRepositoryDeps {
  readonly pool: Pool;
  /** 32-byte AES-256-GCM key. When absent, credentials are stored as NULL. */
  readonly credentialKey?: Buffer;
  /** Label for the key (used for rotation tracking). Stored alongside ciphertext. */
  readonly credentialKeyId?: string;
}

/**
 * Does this connect payload carry anything worth encrypting? The store is
 * source-type-agnostic (ingestion architecture Phase 1: the credential vault
 * serves EVERY authenticated connector, not a plaid/stripe allowlist) — any
 * non-empty credentials object is encrypted at rest under the current key.
 */
function hasCredentialMaterial(credentials: object | undefined): credentials is object {
  return credentials !== undefined && Object.keys(credentials).length > 0;
}

function rowToRecord(row: Record<string, unknown>): SourceRecord {
  return {
    id: row["id"] as string,
    tenant_id: row["tenant_id"] as string,
    type: row["type"] as SourceType,
    status: row["status"] as SourceStatus,
    metadata: (row["metadata"] as Record<string, unknown>) ?? {},
    external_account_ids: (row["external_account_ids"] as string[]) ?? [],
    last_synced_at: (row["last_synced_at"] as string | null) ?? null,
    error_message: (row["error_message"] as string | null) ?? null,
    is_stub: row["is_stub"] as boolean,
    created_at: row["created_at"] as string,
    updated_at: row["updated_at"] as string,
  };
}

export class PostgresSourceRepository
  implements SourceRepository, SourceCredentialStore, SourceSyncJobRepository
{
  public constructor(private readonly deps: PostgresSourceRepositoryDeps) {}

  public async insert(record: SourceRecord): Promise<SourceRecord> {
    return this.insertCore(record, undefined);
  }

  public async insertWithCredentials(
    record: SourceRecord,
    credentials: object,
    externalAccountIds?: string[],
  ): Promise<SourceRecord> {
    return this.insertCore(record, credentials, externalAccountIds);
  }

  private async insertCore(
    record: SourceRecord,
    credentials: object | undefined,
    externalAccountIds: string[] = [],
  ): Promise<SourceRecord> {
    let encCreds: Buffer | null = null;
    let keyId: string | null = null;

    // Fail-closed: if the caller passed credential material (for ANY source
    // type) and no key is loaded, refuse the insert. Without this, the row
    // lands with encrypted_credentials = NULL and a later getCredentials()
    // call returns null — the source becomes silently unusable. Peer review
    // caught the silent-NULL path.
    if (hasCredentialMaterial(credentials)) {
      if (this.deps.credentialKey === undefined || this.deps.credentialKeyId === undefined) {
        throw new Error(
          `PostgresSourceRepository: refusing to insert ${record.type} source with NULL ` +
            "encrypted_credentials. Credentials were provided but no credentialKey / " +
            "credentialKeyId is configured. Wire BRAIN_SOURCE_CREDENTIAL_KEY or the Azure " +
            "Key Vault provider in the api boot (shared/src/crypto/credential-key-provider.ts).",
        );
      }
      const result = encryptCredentials(
        credentials,
        this.deps.credentialKey,
        this.deps.credentialKeyId,
      );
      encCreds = result.ciphertext;
      keyId = result.keyId;
    }

    const { rows } = await withTenantScope(this.deps.pool, record.tenant_id, (c) =>
      c.query<Record<string, unknown>>(
        `INSERT INTO raw_sources
           (id, tenant_id, type, status, encrypted_credentials, credential_key_id,
            metadata, external_account_ids, last_synced_at, error_message, is_stub, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING *`,
        [
          record.id,
          record.tenant_id,
          record.type,
          record.status,
          encCreds,
          keyId,
          JSON.stringify(record.metadata),
          externalAccountIds,
          record.last_synced_at,
          record.error_message,
          record.is_stub,
          record.created_at,
          record.updated_at,
        ],
      ),
    );
    return rowToRecord(rows[0]!);
  }

  public async findById(tenantId: string, id: string): Promise<SourceRecord | null> {
    const { rows } = await withTenantScope(this.deps.pool, tenantId, (c) =>
      c.query<Record<string, unknown>>(
        `SELECT * FROM raw_sources
          WHERE id = $1 AND tenant_id = current_setting('app.tenant_id', true)
          LIMIT 1`,
        [id],
      ),
    );
    return rows[0] !== undefined ? rowToRecord(rows[0]) : null;
  }

  public async list(tenantId: string, filter: ListFilter): Promise<SourceRecord[]> {
    const limit = Math.min(filter.limit ?? 50, 500);
    const conds: string[] = [];
    const vals: unknown[] = [];

    if (filter.type !== undefined) {
      vals.push(filter.type);
      conds.push(`type = $${vals.length}`);
    }
    if (filter.status !== undefined) {
      vals.push(filter.status);
      conds.push(`status = $${vals.length}`);
    }
    if (filter.cursor !== undefined) {
      vals.push(filter.cursor.sort, filter.cursor.id);
      const sortIdx = vals.length - 1;
      const idIdx = vals.length;
      conds.push(
        `(created_at < $${sortIdx}::timestamptz OR (created_at = $${sortIdx}::timestamptz AND id < $${idIdx}))`,
      );
    }
    vals.push(limit);
    const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";

    const { rows } = await withTenantScope(this.deps.pool, tenantId, (c) =>
      c.query<Record<string, unknown>>(
        `SELECT * FROM raw_sources ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT $${vals.length}`,
        vals,
      ),
    );
    return rows.map(rowToRecord);
  }

  public async updateStatus(
    tenantId: string,
    id: string,
    status: SourceStatus,
    fields: Partial<Pick<SourceRecord, "error_message" | "last_synced_at">> = {},
  ): Promise<SourceRecord | null> {
    const { rows } = await withTenantScope(this.deps.pool, tenantId, (c) =>
      c.query<Record<string, unknown>>(
        `UPDATE raw_sources
            SET status = $1,
                error_message = $2,
                last_synced_at = $3,
                updated_at = now()
          WHERE id = $4
          RETURNING *`,
        [status, fields.error_message ?? null, fields.last_synced_at ?? null, id],
      ),
    );
    return rows[0] !== undefined ? rowToRecord(rows[0]) : null;
  }

  // ---- SourceCredentialStore methods -------------------------------------

  public async findByExternalAccountId(
    tenantId: string,
    externalAccountId: string,
  ): Promise<SourceRecord | null> {
    const { rows } = await withTenantScope(this.deps.pool, tenantId, (c) =>
      c.query<Record<string, unknown>>(
        `SELECT * FROM raw_sources
          WHERE $1 = ANY(external_account_ids)
            AND status NOT IN ('disconnected')
          LIMIT 1`,
        [externalAccountId],
      ),
    );
    return rows[0] !== undefined ? rowToRecord(rows[0]) : null;
  }

  public async resolveCredentials(tenantId: string, id: string): Promise<object | null> {
    if (this.deps.credentialKey === undefined) return null;

    const { rows } = await withTenantScope(this.deps.pool, tenantId, (c) =>
      c.query<{ encrypted_credentials: Buffer | null }>(
        `SELECT encrypted_credentials
           FROM raw_sources
          WHERE id = $1 AND tenant_id = current_setting('app.tenant_id', true)
          LIMIT 1`,
        [id],
      ),
    );
    const row = rows[0];
    if (row === undefined || row.encrypted_credentials === null) return null;
    return decryptCredentials(row.encrypted_credentials, this.deps.credentialKey);
  }

  /**
   * Re-encrypt and replace a connection's credentials under the CURRENT key
   * (and key id). This is the storage-side refresh primitive: OAuth-token
   * refresh flows (Merge, Finch, ...) call it after exchanging a refresh
   * token, and key rotation re-stamps credential_key_id as a side effect.
   * Returns false when the source row does not exist for this tenant.
   */
  public async updateCredentials(
    tenantId: string,
    id: string,
    credentials: object,
  ): Promise<boolean> {
    if (this.deps.credentialKey === undefined || this.deps.credentialKeyId === undefined) {
      throw new Error(
        "PostgresSourceRepository: refusing to update credentials without a configured " +
          "credentialKey / credentialKeyId (see credential-key-provider.ts).",
      );
    }
    const { ciphertext, keyId } = encryptCredentials(
      credentials,
      this.deps.credentialKey,
      this.deps.credentialKeyId,
    );
    const { rowCount } = await withTenantScope(this.deps.pool, tenantId, (c) =>
      c.query(
        `UPDATE raw_sources
            SET encrypted_credentials = $2,
                credential_key_id = $3,
                updated_at = now()
          WHERE id = $1
            AND tenant_id = current_setting('app.tenant_id', true)`,
        [id, ciphertext, keyId],
      ),
    );
    return (rowCount ?? 0) > 0;
  }

  public async insertSyncJob(
    tenantId: string,
    job: {
      job_id: string;
      source_id: string;
      status: SourceSyncJobRecord["status"];
      notes?: "stub";
    },
    errorMessage: string | null = null,
  ): Promise<SourceSyncJobRecord> {
    const { rows } = await withTenantScope(this.deps.pool, tenantId, (c) =>
      c.query<Record<string, unknown>>(
        `INSERT INTO raw_source_sync_jobs
           (job_id, tenant_id, source_id, status, error_message, notes)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (tenant_id, job_id) DO UPDATE SET
           status = EXCLUDED.status,
           error_message = EXCLUDED.error_message,
           notes = EXCLUDED.notes,
           updated_at = now()
         RETURNING *`,
        [job.job_id, tenantId, job.source_id, job.status, errorMessage, job.notes ?? null],
      ),
    );
    return syncJobRowToRecord(rows[0]!);
  }

  public async findSyncJob(tenantId: string, jobId: string): Promise<SourceSyncJobRecord | null> {
    const { rows } = await withTenantScope(this.deps.pool, tenantId, (c) =>
      c.query<Record<string, unknown>>(
        `SELECT * FROM raw_source_sync_jobs
          WHERE job_id = $1 AND tenant_id = current_setting('app.tenant_id', true)
          LIMIT 1`,
        [jobId],
      ),
    );
    return rows[0] === undefined ? null : syncJobRowToRecord(rows[0]);
  }
}

function syncJobRowToRecord(row: Record<string, unknown>): SourceSyncJobRecord {
  return {
    job_id: row["job_id"] as string,
    tenant_id: row["tenant_id"] as string,
    source_id: row["source_id"] as string,
    status: row["status"] as SourceSyncJobRecord["status"],
    error_message: (row["error_message"] as string | null) ?? null,
    ...((row["notes"] as "stub" | null) !== null ? { notes: row["notes"] as "stub" } : {}),
    created_at: toIso(row["created_at"] as Date | string),
    updated_at: toIso(row["updated_at"] as Date | string),
  };
}

function toIso(d: Date | string): string {
  return typeof d === "string" ? d : d.toISOString();
}
