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
import type { SourceRecord, SourceStatus, SourceType } from "./types.js";
import type { ListFilter, SourceCredentialStore, SourceRepository } from "./SourceService.js";

export interface PostgresSourceRepositoryDeps {
  readonly pool: Pool;
  /** 32-byte AES-256-GCM key. When absent, credentials are stored as NULL. */
  readonly credentialKey?: Buffer;
  /** Label for the key (used for rotation tracking). Stored alongside ciphertext. */
  readonly credentialKeyId?: string;
}

/** Source types whose credentials should be encrypted at rest. */
const CREDENTIAL_SOURCE_TYPES: ReadonlySet<SourceType> = new Set<SourceType>(["plaid", "stripe"]);

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

export class PostgresSourceRepository implements SourceRepository, SourceCredentialStore {
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

    if (
      credentials !== undefined &&
      this.deps.credentialKey !== undefined &&
      this.deps.credentialKeyId !== undefined &&
      CREDENTIAL_SOURCE_TYPES.has(record.type)
    ) {
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
      c.query<Record<string, unknown>>(`SELECT * FROM raw_sources WHERE id = $1 LIMIT 1`, [id]),
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
    vals.push(limit);
    const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";

    const { rows } = await withTenantScope(this.deps.pool, tenantId, (c) =>
      c.query<Record<string, unknown>>(
        `SELECT * FROM raw_sources ${where} LIMIT $${vals.length}`,
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
        `SELECT encrypted_credentials FROM raw_sources WHERE id = $1 LIMIT 1`,
        [id],
      ),
    );
    const row = rows[0];
    if (row === undefined || row.encrypted_credentials === null) return null;
    return decryptCredentials(row.encrypted_credentials, this.deps.credentialKey);
  }
}
