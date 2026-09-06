import { describe, expect, it, vi } from "vitest";
import { newApiPartnerId, newTenantDeletionJobId, newTenantId } from "@brain/shared";
import {
  AdminTenantDeletionService,
  claimTenantDeletionJob,
  PROTECTED_TENANT_IDS,
  tenantDeletionJobToWire,
} from "./admin-delete.js";

function job(tenantId: string, caller: string) {
  return {
    id: newTenantDeletionJobId(),
    tenant_id: tenantId,
    requested_by: caller,
    status: "queued" as const,
    expected_rows: null,
    deleted_rows: null,
    total_rows_deleted: null,
    blob_purge_job_id: null,
    blob_artifact_count: null,
    last_error: null,
    created_at: new Date(),
    started_at: null,
    completed_at: null,
  };
}

describe("AdminTenantDeletionService", () => {
  it("creates a queued job and returns its wire representation", async () => {
    const tenantId = newTenantId();
    const caller = newApiPartnerId();
    const query = vi.fn((sql: string, values?: unknown[]) => {
      if (sql.includes("SELECT * FROM tenant_deletion_jobs")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (sql.includes("SELECT do_not_delete FROM tenants")) {
        return Promise.resolve({ rows: [{ do_not_delete: false }], rowCount: 1 });
      }
      if (sql.includes("INSERT INTO tenant_deletion_jobs")) {
        return Promise.resolve({
          rows: [{ ...job(tenantId, caller), id: values?.[0] }],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    const release = vi.fn();
    const service = new AdminTenantDeletionService({
      connect: vi.fn(() => Promise.resolve({ query, release })),
    } as never);

    const result = await service.request(tenantId, caller, "create-request");

    expect(result.created).toBe(true);
    expect(result.row.tenant_id).toBe(tenantId);
    expect(tenantDeletionJobToWire(result.row)).toMatchObject({
      job_id: result.row.id,
      tenant_id: tenantId,
      status: "queued",
      counts: { total_deleted: null },
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it("returns the existing job id without inserting another job", async () => {
    const tenantId = newTenantId();
    const caller = newApiPartnerId();
    const existing = job(tenantId, caller);
    const query = vi.fn((sql: string) => {
      if (sql.includes("SELECT * FROM tenant_deletion_jobs")) {
        return Promise.resolve({ rows: [existing], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    const service = new AdminTenantDeletionService({
      connect: vi.fn(() => Promise.resolve({ query, release: vi.fn() })),
    } as never);

    const result = await service.request(tenantId, caller, "request-one");

    expect(result).toEqual({ created: false, row: existing });
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO tenant_deletion_jobs")),
    ).toBe(false);
  });

  it("fails protected tenants closed and writes a rejection audit intent", async () => {
    const tenantId = [...PROTECTED_TENANT_IDS][0] as string;
    const query = vi.fn((sql: string) => {
      if (sql.includes("SELECT * FROM tenant_deletion_jobs")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (sql.includes("SELECT do_not_delete FROM tenants")) {
        return Promise.resolve({ rows: [{ do_not_delete: true }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    const service = new AdminTenantDeletionService({
      connect: vi.fn(() => Promise.resolve({ query, release: vi.fn() })),
    } as never);

    await expect(
      service.request(tenantId, newApiPartnerId(), "protected-attempt"),
    ).rejects.toMatchObject({ code: "tenant_access_denied" });
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes("INSERT INTO tenant_blob_purge_audit_outbox"),
      ),
    ).toBe(true);
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO tenant_deletion_jobs")),
    ).toBe(false);
  });

  it("rolls back a missing tenant and preserves the original error", async () => {
    const tenantId = newTenantId();
    const query = vi.fn((sql: string) => {
      if (sql.includes("SELECT * FROM tenant_deletion_jobs")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (sql.includes("SELECT do_not_delete FROM tenants")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (sql === "ROLLBACK") return Promise.reject(new Error("rollback failed"));
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    const service = new AdminTenantDeletionService({
      connect: vi.fn(() => Promise.resolve({ query, release: vi.fn() })),
    } as never);

    await expect(
      service.request(tenantId, newApiPartnerId(), "missing-request"),
    ).rejects.toMatchObject({ code: "tenant_not_found" });
  });

  it("finds a job globally by its opaque id and returns null when absent", async () => {
    const row = job(newTenantId(), newApiPartnerId());
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [row], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const service = new AdminTenantDeletionService({ query } as never);

    await expect(service.find(row.id)).resolves.toBe(row);
    await expect(service.find(newTenantDeletionJobId())).resolves.toBeNull();
  });

  it("claims one queued job and reports an empty queue", async () => {
    const row = job(newTenantId(), newApiPartnerId());
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [row], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(claimTenantDeletionJob({ query } as never, "worker-one")).resolves.toBe(row);
    await expect(claimTenantDeletionJob({ query } as never, "worker-one")).resolves.toBeNull();
    expect(query.mock.calls[0]?.[1]).toEqual(["worker-one"]);
  });
});
