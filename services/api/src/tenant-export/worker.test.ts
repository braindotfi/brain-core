import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  InMemoryAuditEmitter,
  MemoryBlobAdapter,
  newTenantExportJobId,
  newTenantId,
} from "@brain/shared";
import { TenantExportService } from "./service.js";
import { runTenantExportCycle } from "./worker.js";
import type { TenantExportJobRow } from "./repository.js";

const TENANT = newTenantId();
const OTHER_TENANT = newTenantId();
const JOB_ID = newTenantExportJobId();

describe("tenant export worker", () => {
  it("assembles a tenant-scoped NDJSON archive and emits tenant.exported", async () => {
    const job = jobRow({ status: "queued" });
    const app = appPool(job);
    const blob = new MemoryBlobAdapter();
    const audit = new InMemoryAuditEmitter();
    const service = new TenantExportService({ pool: app.pool, blob, audit });

    const result = await runTenantExportCycle(
      {
        scanPool: scanPool({ pending: [{ id: JOB_ID, tenant_id: TENANT }] }),
        appPool: app.pool,
        blob,
        service,
      },
      { batchSize: 1 },
    );

    expect(app.failed).toEqual([]);
    expect(result).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
    expect(app.succeeded).toHaveLength(1);
    expect(audit.events.map((event) => event.action)).toEqual(["tenant.exported"]);
    const outputUri = app.succeeded[0]?.outputBlobUri;
    expect(outputUri).toMatch(new RegExp(`^${TENANT}/exports/${JOB_ID}-`));
    const archive = await readBlob(blob, outputUri!);
    const rows = archive
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { entity_type: string; data: Record<string, unknown> });
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entity_type: "ledger_account" }),
        expect.objectContaining({ entity_type: "member" }),
        expect.objectContaining({ entity_type: "source" }),
        expect.objectContaining({ entity_type: "audit_event" }),
      ]),
    );
    expect(JSON.stringify(rows)).toContain(TENANT);
    expect(JSON.stringify(rows)).not.toContain(OTHER_TENANT);
  });

  it("purges expired export archives without purging the whole tenant prefix", async () => {
    const job = jobRow({
      status: "succeeded",
      outputBlobUri: `${TENANT}/exports/expired.ndjson`,
      expiresAt: new Date("2020-01-01T00:00:00Z"),
    });
    const app = appPool(job);
    const blob = new MemoryBlobAdapter();
    await blob.put(job.output_blob_uri!, Buffer.from("expired"), {
      contentType: "application/x-ndjson",
      immutable: false,
    });
    await blob.put(`${TENANT}/2026/07/20/raw`, Buffer.from("raw"), {
      contentType: "application/octet-stream",
      immutable: true,
    });
    const purgeTenant = vi.spyOn(blob, "purgeTenant");
    const service = new TenantExportService({
      pool: app.pool,
      blob,
      audit: new InMemoryAuditEmitter(),
    });

    const result = await runTenantExportCycle(
      {
        scanPool: scanPool({
          expired: [{ id: job.id, tenant_id: TENANT, output_blob_uri: job.output_blob_uri! }],
        }),
        appPool: app.pool,
        blob,
        service,
      },
      { batchSize: 1 },
    );

    expect(result.purged).toBe(1);
    expect(app.purged).toEqual([job.id]);
    expect(purgeTenant).not.toHaveBeenCalled();
    await expect(blob.get(job.output_blob_uri!)).rejects.toThrow();
    await expect(readBlob(blob, `${TENANT}/2026/07/20/raw`)).resolves.toBe("raw");
  });
});

function scanPool(input: {
  pending?: Array<{ id: string; tenant_id: string }>;
  expired?: Array<{ id: string; tenant_id: string; output_blob_uri: string }>;
}): Pool {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("expires_at <= now()")) {
        return { rows: input.expired ?? [], rowCount: input.expired?.length ?? 0 };
      }
      return { rows: input.pending ?? [], rowCount: input.pending?.length ?? 0 };
    }),
  } as unknown as Pool;
}

function appPool(job: TenantExportJobRow) {
  const succeeded: Array<{ outputBlobUri: string; byteSize: number }> = [];
  const failed: unknown[] = [];
  const purged: string[] = [];
  const client = {
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      if (
        sql === "BEGIN" ||
        sql === "COMMIT" ||
        sql === "ROLLBACK" ||
        sql.startsWith("SELECT set_config")
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.startsWith("UPDATE tenant_export_jobs") && sql.includes("status = 'running'")) {
        return { rows: [job], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE tenant_export_jobs") && sql.includes("status = 'succeeded'")) {
        succeeded.push({ outputBlobUri: String(values?.[1]), byteSize: Number(values?.[2]) });
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE tenant_export_jobs") && sql.includes("status = 'failed'")) {
        failed.push(values?.[1]);
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE tenant_export_jobs") && sql.includes("purged_at = now()")) {
        purged.push(String(values?.[0]));
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("FROM ledger_accounts")) {
        return { rows: [{ data: { id: "acct_a", owner_id: TENANT } }], rowCount: 1 };
      }
      if (sql.includes("FROM members")) {
        return {
          rows: [
            {
              tenant_id: TENANT,
              id: "user_admin",
              email: "admin@example.com",
              display_name: "Admin",
              role: "admin",
              status: "active",
              active: true,
              approval_domains: ["payments"],
              per_item_limit_cents: "100",
              requires_second_approver_above_cents: null,
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM raw_sources")) {
        return { rows: [{ data: { id: "src_a", tenant_id: TENANT } }], rowCount: 1 };
      }
      if (sql.includes("FROM audit_events")) {
        return { rows: [{ data: { id: "evt_a", tenant_id: TENANT } }], rowCount: 1 };
      }
      if (sql.includes("WITH unified AS")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("raw_artifacts") || sql.includes("ledger_")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  return {
    pool: { connect: vi.fn(async () => client) } as unknown as Pool,
    succeeded,
    failed,
    purged,
  };
}

function jobRow(input: {
  status: TenantExportJobRow["status"];
  outputBlobUri?: string;
  expiresAt?: Date;
}): TenantExportJobRow {
  const now = new Date("2026-07-20T00:00:00Z");
  return {
    id: JOB_ID,
    tenant_id: TENANT,
    status: input.status,
    output_blob_uri: input.outputBlobUri ?? null,
    byte_size: null,
    expires_at: input.expiresAt ?? new Date("2026-07-27T00:00:00Z"),
    error: null,
    requested_by: "user_admin",
    locked_at: null,
    locked_by: null,
    started_at: null,
    finished_at: null,
    purged_at: null,
    created_at: now,
    updated_at: now,
  };
}

async function readBlob(blob: MemoryBlobAdapter, path: string): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of await blob.get(path)) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString("utf8");
}
