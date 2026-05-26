/**
 * SourceService — owns the `/v1/sources/*` lifecycle.
 *
 * v0.3 ship uses an in-memory `SourceRepository` interface (one impl in
 * this file). A follow-up commit wires a Postgres-backed repository
 * against a new `raw_sources` table. The service layer is unchanged.
 *
 * Source: https://docs.brain.fi/api-reference/sources-api.
 *
 * @packageDocumentation
 */

import { brainError, newSourceId, type ServiceCallContext } from "@brain/shared";
import { getConnector, isStub } from "./connectors.js";
import {
  SOURCE_TYPES,
  type ConnectInput,
  type SourceRecord,
  type SourceStatus,
  type SourceType,
  type SyncJobDescriptor,
} from "./types.js";

const SOURCE_TYPES_SET: ReadonlySet<string> = new Set<string>(SOURCE_TYPES);

export interface SourceRepository {
  insert(record: SourceRecord): Promise<SourceRecord>;
  findById(tenantId: string, id: string): Promise<SourceRecord | null>;
  list(tenantId: string, filter: ListFilter): Promise<SourceRecord[]>;
  updateStatus(
    tenantId: string,
    id: string,
    status: SourceStatus,
    fields?: Partial<Pick<SourceRecord, "error_message" | "last_synced_at">>,
  ): Promise<SourceRecord | null>;
}

/**
 * Extended interface implemented by repositories that support encrypted
 * credential storage. Not part of the core `SourceRepository` contract so
 * that `InMemorySourceRepository` can stay secret-free in tests.
 */
export interface SourceCredentialStore {
  insertWithCredentials(
    record: SourceRecord,
    credentials: object,
    externalAccountIds?: string[],
  ): Promise<SourceRecord>;
  findByExternalAccountId(
    tenantId: string,
    externalAccountId: string,
  ): Promise<SourceRecord | null>;
  resolveCredentials(tenantId: string, id: string): Promise<object | null>;
}

export interface ListFilter {
  readonly type?: SourceType;
  readonly status?: SourceStatus;
  readonly limit?: number;
}

/**
 * In-memory `SourceRepository`. Multi-tenant safe (keyed by
 * tenant_id). The map is process-local — restarts lose state. For tests
 * and the v0.3 demo path; production-grade Postgres backing is a
 * follow-up PR.
 */
export class InMemorySourceRepository implements SourceRepository {
  private readonly byId: Map<string, SourceRecord> = new Map();

  public async insert(record: SourceRecord): Promise<SourceRecord> {
    this.byId.set(this.key(record.tenant_id, record.id), record);
    return record;
  }

  public async findById(tenantId: string, id: string): Promise<SourceRecord | null> {
    return this.byId.get(this.key(tenantId, id)) ?? null;
  }

  public async list(tenantId: string, filter: ListFilter): Promise<SourceRecord[]> {
    const limit = Math.min(filter.limit ?? 50, 500);
    const tenantPrefix = `${tenantId}:`;
    const out: SourceRecord[] = [];
    for (const [k, v] of this.byId) {
      if (!k.startsWith(tenantPrefix)) continue;
      if (filter.type !== undefined && v.type !== filter.type) continue;
      if (filter.status !== undefined && v.status !== filter.status) continue;
      out.push(v);
      if (out.length >= limit) break;
    }
    return out;
  }

  public async updateStatus(
    tenantId: string,
    id: string,
    status: SourceStatus,
    fields: Partial<Pick<SourceRecord, "error_message" | "last_synced_at">> = {},
  ): Promise<SourceRecord | null> {
    const existing = this.byId.get(this.key(tenantId, id));
    if (existing === undefined) return null;
    const updated: SourceRecord = {
      ...existing,
      status,
      error_message: fields.error_message ?? existing.error_message,
      last_synced_at: fields.last_synced_at ?? existing.last_synced_at,
      updated_at: new Date().toISOString(),
    };
    this.byId.set(this.key(tenantId, id), updated);
    return updated;
  }

  private key(tenantId: string, id: string): string {
    return `${tenantId}:${id}`;
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class SourceService {
  public constructor(
    private readonly repo: SourceRepository,
    private readonly credentialStore?: SourceCredentialStore,
  ) {}

  public async connect(
    ctx: ServiceCallContext,
    input: Omit<ConnectInput, "tenant_id">,
  ): Promise<SourceRecord> {
    if (!SOURCE_TYPES_SET.has(input.type)) {
      throw brainError("request_body_invalid", `unsupported source type: ${input.type}`);
    }
    const connector = getConnector(input.type);
    await connector.validateCredentials({
      tenantId: ctx.tenantId,
      credentials: input.credentials,
    });
    const now = new Date().toISOString();
    const record: SourceRecord = {
      id: newSourceId(),
      tenant_id: ctx.tenantId,
      type: input.type,
      status: "active",
      metadata: input.metadata ?? {},
      last_synced_at: null,
      error_message: null,
      is_stub: isStub(input.type),
      created_at: now,
      updated_at: now,
    };

    if (this.credentialStore !== undefined) {
      // Derive external_account_ids from the credentials when possible
      // (Plaid: account_id maps to ledger external_account_id).
      const externalIds: string[] = [];
      const creds = input.credentials;
      if (typeof creds["account_id"] === "string" && creds["account_id"].length > 0) {
        externalIds.push(creds["account_id"]);
      }
      return this.credentialStore.insertWithCredentials(record, creds, externalIds);
    }
    return this.repo.insert(record);
  }

  /**
   * Resolve encrypted credentials for a source connected to the given
   * external_account_id (e.g. Plaid account_id). Returns null when no
   * active source is found or credential encryption is not configured.
   *
   * Callers outside the raw service must go through this method — never
   * query raw_sources directly (§1 principle: cross-service reads via API).
   */
  public async resolveCredentialsForAccount(
    ctx: ServiceCallContext,
    externalAccountId: string,
  ): Promise<{ source_id: string; type: SourceType; credentials: object } | null> {
    if (this.credentialStore === undefined) return null;
    const record = await this.credentialStore.findByExternalAccountId(
      ctx.tenantId,
      externalAccountId,
    );
    if (record === null || record.status === "disconnected") return null;
    const credentials = await this.credentialStore.resolveCredentials(ctx.tenantId, record.id);
    if (credentials === null) return null;
    return { source_id: record.id, type: record.type, credentials };
  }

  public async get(ctx: ServiceCallContext, id: string): Promise<SourceRecord | null> {
    return this.repo.findById(ctx.tenantId, id);
  }

  public async list(ctx: ServiceCallContext, filter: ListFilter): Promise<SourceRecord[]> {
    return this.repo.list(ctx.tenantId, filter);
  }

  public async disconnect(ctx: ServiceCallContext, id: string): Promise<SourceRecord | null> {
    const existing = await this.repo.findById(ctx.tenantId, id);
    if (existing === null) return null;
    return this.repo.updateStatus(ctx.tenantId, id, "disconnected");
  }

  public async sync(ctx: ServiceCallContext, id: string): Promise<SyncJobDescriptor | null> {
    const existing = await this.repo.findById(ctx.tenantId, id);
    if (existing === null) return null;
    if (existing.status === "disconnected") {
      throw brainError("source_not_found", "cannot sync a disconnected source");
    }
    const connector = getConnector(existing.type);
    const job = await connector.sync(id);
    await this.repo.updateStatus(ctx.tenantId, id, "active", {
      last_synced_at: new Date().toISOString(),
    });
    return job;
  }
}
