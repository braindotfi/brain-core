import { createHash } from "node:crypto";
import type { Pool } from "pg";
import {
  brainError,
  withTenantScope,
  type AuditEmitter,
  type BlobAdapter,
  type ServiceCallContext,
  type TenantScopedClient,
} from "@brain/shared";
import { listMembers, listProposals } from "@brain/execution";
import {
  markTenantExportJobFailed,
  markTenantExportJobSucceeded,
  type TenantExportJobRow,
} from "./repository.js";

const EXPORT_MIME = "application/x-ndjson";

export interface TenantExportServiceDeps {
  pool: Pool;
  blob: BlobAdapter;
  audit: AuditEmitter;
}

export class TenantExportService {
  public constructor(private readonly deps: TenantExportServiceDeps) {}

  public async assembleExport(
    ctx: ServiceCallContext,
    job: TenantExportJobRow,
  ): Promise<{ outputBlobUri: string; byteSize: number }> {
    const lines = await withTenantScope(this.deps.pool, job.tenant_id, async (client) => {
      const out: string[] = [];
      await appendTable(out, client, "ledger_account", "ledger_accounts", "owner_id");
      await appendTable(out, client, "ledger_transaction", "ledger_transactions", "owner_id");
      await appendTable(out, client, "ledger_counterparty", "ledger_counterparties", "owner_id");
      await appendTable(out, client, "ledger_obligation", "ledger_obligations", "owner_id");
      await appendTable(out, client, "ledger_invoice", "ledger_invoices", "owner_id");
      await appendTable(out, client, "ledger_document", "ledger_documents", "owner_id");
      await appendRawArtifacts(out, client);
      await appendMembers(out, client);
      await appendSources(out, client);
      await appendAuditEvents(out, client);
      return out;
    });

    await appendProposals(lines, this.deps.pool, ctx);

    const body = Buffer.from(`${lines.join("\n")}\n`, "utf8");
    const sha = createHash("sha256").update(body).digest("hex");
    const path = `${job.tenant_id}/exports/${job.id}-${sha}.ndjson`;
    const object = await this.deps.blob.put(path, body, {
      contentType: EXPORT_MIME,
      metadata: {
        tenant_id: job.tenant_id,
        tenant_export_job_id: job.id,
        expires_at: toIso(job.expires_at),
      },
      immutable: false,
    });

    try {
      await this.deps.audit.emit({
        tenantId: job.tenant_id,
        layer: "audit",
        actor: ctx.actor,
        action: "tenant.exported",
        inputs: { tenant_id: job.tenant_id, job_id: job.id },
        outputs: {
          byte_size: body.byteLength,
          expires_at: toIso(job.expires_at),
          entity_count: lines.length,
        },
        idempotencyKey: `${job.id}:tenant.exported`,
      });
    } catch (err) {
      await this.deps.blob.purgeObject(object.uri);
      throw err;
    }

    await withTenantScope(this.deps.pool, job.tenant_id, (client) =>
      markTenantExportJobSucceeded(client, job.id, {
        outputBlobUri: object.uri,
        byteSize: body.byteLength,
      }),
    );
    return { outputBlobUri: object.uri, byteSize: body.byteLength };
  }

  public async markFailed(tenantId: string, jobId: string, err: unknown): Promise<void> {
    await withTenantScope(this.deps.pool, tenantId, (client) =>
      markTenantExportJobFailed(client, jobId, errorToDetails(err)),
    );
  }
}

async function appendTable(
  lines: string[],
  client: TenantScopedClient,
  entityType: string,
  table: string,
  tenantColumn: "owner_id" | "tenant_id",
): Promise<void> {
  const { rows } = await client.query<{ data: Record<string, unknown> }>(
    `SELECT to_jsonb(t) AS data
       FROM ${table} t
      WHERE ${tenantColumn} = current_setting('app.tenant_id', true)
      ORDER BY id ASC`,
  );
  for (const row of rows) appendRecord(lines, entityType, row.data);
}

async function appendRawArtifacts(lines: string[], client: TenantScopedClient): Promise<void> {
  const { rows } = await client.query<{ data: Record<string, unknown> }>(
    `SELECT jsonb_build_object(
              'id', id,
              'tenant_id', tenant_id,
              'source_type', source_type,
              'source_ref', source_ref,
              'sha256', encode(sha256, 'hex'),
              'size_bytes', bytes,
              'mime_type', mime_type,
              'blob_uri', blob_uri,
              'envelope', jsonb_build_object(
                'source_schema', source_schema,
                'object_type', object_type,
                'external_id', external_id,
                'operation', operation,
                'effective_at', effective_at,
                'observed_at', observed_at,
                'original_source', original_source,
                'intermediaries', intermediaries,
                'source_id', source_id,
                'source_version', source_version,
                'idempotency_key', idempotency_key
              ),
              'schema_name', source_schema,
              'schema_version', NULL,
              'tombstoned_at', tombstoned_at,
              'created_at', ingested_at
            ) AS data
       FROM raw_artifacts
      WHERE tenant_id = current_setting('app.tenant_id', true)
      ORDER BY id ASC`,
  );
  for (const row of rows) appendRecord(lines, "raw_artifact_metadata", row.data);
}

async function appendMembers(lines: string[], client: TenantScopedClient): Promise<void> {
  const members = await listMembers(client, { limit: 10_000 });
  for (const member of members) appendRecord(lines, "member", member);
}

async function appendSources(lines: string[], client: TenantScopedClient): Promise<void> {
  const { rows } = await client.query<{ data: Record<string, unknown> }>(
    `SELECT to_jsonb(s) - 'encrypted_credentials' - 'credential_key_id' AS data
       FROM raw_sources s
      WHERE tenant_id = current_setting('app.tenant_id', true)
      ORDER BY id ASC`,
  );
  for (const row of rows) appendRecord(lines, "source", row.data);
}

async function appendAuditEvents(lines: string[], client: TenantScopedClient): Promise<void> {
  const { rows } = await client.query<{ data: Record<string, unknown> }>(
    `SELECT to_jsonb(a) AS data
       FROM audit_events a
      WHERE tenant_id = current_setting('app.tenant_id', true)
      ORDER BY created_at ASC, id ASC`,
  );
  for (const row of rows) appendRecord(lines, "audit_event", row.data);
}

async function appendProposals(
  lines: string[],
  pool: Pool,
  ctx: ServiceCallContext,
): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await listProposals(pool, ctx, { limit: 100, ...(cursor ? { cursor } : {}) });
    for (const proposal of page.proposals) appendRecord(lines, "proposal", proposal);
    cursor = page.next_cursor ?? undefined;
  } while (cursor !== undefined);
}

function appendRecord(lines: string[], entityType: string, data: unknown): void {
  lines.push(JSON.stringify({ entity_type: entityType, data }, jsonReplacer));
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

function errorToDetails(err: unknown): Record<string, unknown> {
  if (err !== null && typeof err === "object" && "code" in err) {
    const candidate = err as { code?: unknown; message?: unknown; details?: unknown };
    return {
      code: typeof candidate.code === "string" ? candidate.code : "internal_server_error",
      message: typeof candidate.message === "string" ? candidate.message : "tenant export failed",
      ...(candidate.details !== undefined ? { details: candidate.details } : {}),
    };
  }
  return {
    code: "internal_server_error",
    message: err instanceof Error ? err.message : String(err),
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function assertExportDownloadable(job: TenantExportJobRow, now: Date): void {
  if (job.status === "succeeded" && new Date(job.expires_at).getTime() <= now.getTime()) {
    throw brainError("auth_expired", "tenant export archive has expired", {
      statusOverride: 410,
    });
  }
  if (job.status !== "succeeded" || job.output_blob_uri === null) {
    throw brainError("tenant_export_job_not_found", "tenant export archive is not available", {
      statusOverride: 404,
    });
  }
}
