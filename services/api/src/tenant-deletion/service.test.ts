import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { InMemoryAuditEmitter, newTenantId, newUserId } from "@brain/shared";
import type { Pool } from "pg";
import { TenantDeletionService, TENANT_SCOPED_TABLES, PRESERVED_TABLES } from "./service.js";

const TENANT = newTenantId();
const USER = newUserId();

function fakePool(deletePerTable: Record<string, number>, blobUris: string[] = []): Pool {
  const client = {
    query: vi.fn((sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      // Pre-DELETE snapshot of raw_artifacts blob URIs.
      if (sql.startsWith("SELECT blob_uri FROM raw_artifacts")) {
        return Promise.resolve({
          rows: blobUris.map((u) => ({ blob_uri: u })),
          rowCount: blobUris.length,
        });
      }
      const match = sql.match(/DELETE FROM (\w+)/);
      const table = match?.[1];
      const rowCount = table !== undefined ? (deletePerTable[table] ?? 0) : 0;
      return Promise.resolve({ rows: [], rowCount });
    }),
    release: vi.fn(),
  };
  return {
    connect: vi.fn(() => Promise.resolve(client)),
  } as unknown as Pool;
}

describe("TenantDeletionService", () => {
  it("deletes across every tenant-scoped table in one transaction", async () => {
    const pool = fakePool({
      raw_artifacts: 3,
      ledger_payment_intents: 5,
      wiki_pages: 7,
      policy_decisions: 4,
      agents: 2,
    });
    const audit = new InMemoryAuditEmitter();
    const svc = new TenantDeletionService({ privilegedPool: pool, audit });

    const result = await svc.deleteTenant({ tenantId: TENANT, actor: USER }, TENANT);

    expect(result.tenantId).toBe(TENANT);
    expect(result.deletedRows.raw_artifacts).toBe(3);
    expect(result.deletedRows.ledger_payment_intents).toBe(5);
    expect(result.totalRows).toBe(3 + 5 + 7 + 4 + 2);
  });

  it("preserves audit_events and audit_anchors (no DELETE issued)", async () => {
    const pool = fakePool({});
    const audit = new InMemoryAuditEmitter();
    const svc = new TenantDeletionService({ privilegedPool: pool, audit });
    await svc.deleteTenant({ tenantId: TENANT, actor: USER }, TENANT);

    // Inspect every DELETE call the service issued.
    const client = await pool.connect();
    const calls = vi.mocked(client.query).mock.calls.map((c) => c[0] as string);
    const deletes = calls.filter((c) => c.startsWith("DELETE FROM "));
    expect(deletes.some((d) => d.includes("audit_events"))).toBe(false);
    expect(deletes.some((d) => d.includes("audit_anchors"))).toBe(false);
  });

  it("emits a tenant.deleted audit event with the per-table breakdown", async () => {
    const pool = fakePool({ raw_artifacts: 2, ledger_accounts: 3 });
    const audit = new InMemoryAuditEmitter();
    const svc = new TenantDeletionService({ privilegedPool: pool, audit });
    await svc.deleteTenant({ tenantId: TENANT, actor: USER }, TENANT);

    const events = audit.events;
    expect(events).toHaveLength(1);
    const evt = events[0]!;
    expect(evt.action).toBe("tenant.deleted");
    expect(evt.tenantId).toBe(TENANT);
    const outputs = evt.outputs as {
      total_rows_deleted: number;
      per_table_counts: Record<string, number>;
      preserved: string[];
    };
    expect(outputs.total_rows_deleted).toBe(5);
    expect(outputs.per_table_counts.raw_artifacts).toBe(2);
    expect(outputs.per_table_counts.ledger_accounts).toBe(3);
    expect(outputs.preserved).toContain("audit_events");
    expect(outputs.preserved).toContain("audit_anchors");
  });

  it("surfaces the blob URIs that operators must purge out-of-band (GDPR Art 17)", async () => {
    const uris = [
      "tnt_x/2026/05/29/aaaa1111",
      "tnt_x/2026/05/30/bbbb2222",
      "tnt_x/2026/05/30/cccc3333",
    ];
    const pool = fakePool({ raw_artifacts: 3 }, uris);
    const audit = new InMemoryAuditEmitter();
    const svc = new TenantDeletionService({ privilegedPool: pool, audit });
    const result = await svc.deleteTenant({ tenantId: TENANT, actor: USER }, TENANT);

    // Return shape: caller (route + operator) sees the orphan list.
    expect(result.blobArtifactCount).toBe(3);
    expect(result.blobUrisPendingPurge).toEqual(uris);

    // Audit chain: the same list is on the tenant.deleted event so the
    // verify-without-trusting-Brain promise still surfaces what's NOT yet
    // gone.
    const outputs = audit.events[0]!.outputs as {
      blob_artifact_count: number;
      blob_uris_pending_purge: string[];
    };
    expect(outputs.blob_artifact_count).toBe(3);
    expect(outputs.blob_uris_pending_purge).toEqual(uris);
  });

  it("reports 0 blob artifacts when the tenant uploaded nothing", async () => {
    const pool = fakePool({ raw_artifacts: 0 }, []);
    const audit = new InMemoryAuditEmitter();
    const svc = new TenantDeletionService({ privilegedPool: pool, audit });
    const result = await svc.deleteTenant({ tenantId: TENANT, actor: USER }, TENANT);

    expect(result.blobArtifactCount).toBe(0);
    expect(result.blobUrisPendingPurge).toEqual([]);
    const outputs = audit.events[0]!.outputs as { blob_artifact_count: number };
    expect(outputs.blob_artifact_count).toBe(0);
  });

  it("selects blob URIs BEFORE the DELETE wipes raw_artifacts rows", async () => {
    // Critical ordering: if the SELECT happens after the DELETE, the URI
    // list is always empty and the GDPR honesty story collapses silently.
    const pool = fakePool({ raw_artifacts: 1 }, ["tnt_x/2026/05/30/abc"]);
    const audit = new InMemoryAuditEmitter();
    const svc = new TenantDeletionService({ privilegedPool: pool, audit });
    await svc.deleteTenant({ tenantId: TENANT, actor: USER }, TENANT);

    const client = await pool.connect();
    const sqlCalls = vi.mocked(client.query).mock.calls.map((c) => c[0] as string);
    const selectIdx = sqlCalls.findIndex((s) => s.startsWith("SELECT blob_uri FROM raw_artifacts"));
    const deleteIdx = sqlCalls.findIndex((s) => /^DELETE FROM raw_artifacts/.test(s));
    expect(selectIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeGreaterThan(-1);
    expect(selectIdx).toBeLessThan(deleteIdx);
  });

  it("rolls back on a DELETE failure and does not emit the tombstone event", async () => {
    const client = {
      query: vi.fn((sql: string) => {
        if (sql.includes("ledger_payment_intents")) {
          return Promise.reject(new Error("constraint violation"));
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(() => Promise.resolve(client)) } as unknown as Pool;
    const audit = new InMemoryAuditEmitter();
    const svc = new TenantDeletionService({ privilegedPool: pool, audit });

    await expect(svc.deleteTenant({ tenantId: TENANT, actor: USER }, TENANT)).rejects.toThrow(
      "constraint violation",
    );

    // Last call after the failure must be ROLLBACK, not COMMIT.
    const sqlCalls = client.query.mock.calls.map((c) => c[0] as string);
    expect(sqlCalls).toContain("ROLLBACK");
    expect(sqlCalls).not.toContain("COMMIT");
    // No audit emit on rollback.
    expect(audit.events).toHaveLength(0);
  });

  it("enqueues a durable blob purge job and emits purge_requested when blobs exist", async () => {
    // Fake pool that returns a job id for the purge-queue INSERT.
    const client = {
      query: vi.fn((sql: string) => {
        if (sql.startsWith("SELECT blob_uri FROM raw_artifacts")) {
          return Promise.resolve({ rows: [{ blob_uri: "tnt_x/a" }], rowCount: 1 });
        }
        if (sql.includes("INSERT INTO tenant_blob_purge_jobs")) {
          return Promise.resolve({ rows: [{ id: "tbp_JOB1" }], rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(() => Promise.resolve(client)) } as unknown as Pool;
    const audit = new InMemoryAuditEmitter();
    const svc = new TenantDeletionService({ privilegedPool: pool, audit });

    const result = await svc.deleteTenant({ tenantId: TENANT, actor: USER }, TENANT);

    expect(result.blobPurgeJobId).toBe("tbp_JOB1");
    // The enqueue INSERT runs inside the transaction, before the deletes.
    const calls = client.query.mock.calls.map((c) => c[0] as string);
    const insertIdx = calls.findIndex((s) => s.includes("INSERT INTO tenant_blob_purge_jobs"));
    const firstDeleteIdx = calls.findIndex((s) => s.startsWith("DELETE FROM "));
    expect(insertIdx).toBeGreaterThan(-1);
    expect(insertIdx).toBeLessThan(firstDeleteIdx);
    // tenant.deleted is still first; purge_requested follows.
    expect(audit.events[0]!.action).toBe("tenant.deleted");
    const requested = audit.events.find((e) => e.action === "tenant_blob.purge_requested");
    expect(requested).toBeDefined();
    expect(
      (requested!.outputs as { tenant_blob_purge_job_id: string }).tenant_blob_purge_job_id,
    ).toBe("tbp_JOB1");
  });

  it("does NOT enqueue a purge job when the tenant uploaded no blobs", async () => {
    const pool = fakePool({ raw_artifacts: 0 }, []);
    const audit = new InMemoryAuditEmitter();
    const svc = new TenantDeletionService({ privilegedPool: pool, audit });
    const result = await svc.deleteTenant({ tenantId: TENANT, actor: USER }, TENANT);
    expect(result.blobPurgeJobId).toBeNull();
    expect(audit.events.some((e) => e.action === "tenant_blob.purge_requested")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Registry-derived coverage test.
//
// Scans every migration in services/*/migrations and asserts each
// tenant-scoped table (one whose CREATE TABLE includes a `tenant_id` or
// `owner_id` column) is either in TENANT_SCOPED_TABLES (to be deleted) or
// in PRESERVED_TABLES (intentionally retained). A new migration that adds
// a tenant-scoped table without updating the deletion list fails this test
// — partial deletion is worse than no deletion for GDPR.
// ---------------------------------------------------------------------------

interface ScannedTable {
  table: string;
  column: "owner_id" | "tenant_id" | "id";
  migrationFile: string;
}

function repoRoot(): string {
  // From this test file (services/api/src/tenant-deletion/), the repo root
  // is four levels up. URL pathname percent-encodes spaces (e.g. "Brain
  // Code" → "Brain%20Code"); decodeURIComponent restores the literal path
  // so readdirSync can find it.
  const raw = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
  const here = decodeURIComponent(raw);
  return join(here, "..", "..", "..", "..");
}

function listMigrationFiles(): string[] {
  const services = ["api", "raw", "ledger", "wiki", "policy", "audit", "execution"];
  const files: string[] = [];
  for (const svc of services) {
    const dir = join(repoRoot(), "services", svc, "migrations");
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (f.endsWith(".sql")) files.push(join(dir, f));
    }
  }
  return files;
}

/**
 * Find every CREATE TABLE in `sql` and infer whether each is tenant-scoped.
 * A table is tenant-scoped if its CREATE TABLE body declares `tenant_id` or
 * `owner_id` as a column. The `tenants` table is treated specially because
 * it's keyed by `id` (it IS the tenant registry row).
 */
function scanCreatedTables(sql: string, file: string): ScannedTable[] {
  // Strip SQL line comments first — a `);` inside a `-- foo);` comment would
  // otherwise prematurely terminate the non-greedy body capture below
  // (real bug: services/api/migrations/0003_self_serve_onboarding.sql has
  // "-- (raw token); the raw token is only ever emailed" inside the
  // email_verifications body).
  const stripped = sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
  const out: ScannedTable[] = [];
  // Match: CREATE TABLE [IF NOT EXISTS] <name> ( ... );  (one statement)
  // The body capture is non-greedy and stops at the closing `);`.
  const re = /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?([a-z_][\w]*)\s*\(([\s\S]*?)\);/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const name = m[1]!;
    const body = m[2]!;
    if (/\btenant_id\b/.test(body)) {
      out.push({ table: name, column: "tenant_id", migrationFile: file });
    } else if (/\bowner_id\b/.test(body)) {
      out.push({ table: name, column: "owner_id", migrationFile: file });
    } else if (name === "tenants") {
      // tenants is the registry; its key is `id`. Treated as tenant-scoped
      // for this purpose so the deletion path includes the row itself.
      out.push({ table: name, column: "id", migrationFile: file });
    }
  }
  return out;
}

describe("TenantDeletionService — registry coverage (migration-derived)", () => {
  const scanned: ScannedTable[] = listMigrationFiles().flatMap((f) =>
    scanCreatedTables(readFileSync(f, "utf8"), f),
  );

  const listedDelete = new Set(TENANT_SCOPED_TABLES.map((t) => t.table));
  // `tenants` is handled separately (DELETE by `id`); count it as covered.
  listedDelete.add("tenants");

  it("the migration set is non-empty (sanity)", () => {
    expect(scanned.length).toBeGreaterThan(20);
  });

  it("every tenant-scoped table is either in the deletion list or explicitly preserved", () => {
    const uncovered = scanned.filter(
      (t) => !listedDelete.has(t.table) && !PRESERVED_TABLES.has(t.table),
    );
    if (uncovered.length > 0) {
      const msg = uncovered
        .map((t) => `  - ${t.table} (${t.column}) from ${t.migrationFile}`)
        .join("\n");
      throw new Error(
        `Tenant-scoped tables missing from TENANT_SCOPED_TABLES or PRESERVED_TABLES:\n${msg}\n\n` +
          "Add each to services/api/src/tenant-deletion/service.ts. Partial deletion is " +
          "worse than no deletion for GDPR.",
      );
    }
  });

  it("every entry in TENANT_SCOPED_TABLES corresponds to a real migration-declared table", () => {
    // Catch the reverse: a table dropped from migrations but still referenced
    // by the deletion list — that would crash the DELETE at runtime.
    const scannedNames = new Set(scanned.map((t) => t.table));
    const orphans = TENANT_SCOPED_TABLES.filter((t) => !scannedNames.has(t.table));
    expect(orphans).toEqual([]);
  });

  it("preserved tables (audit chain) are not in the deletion list", () => {
    const conflicts = TENANT_SCOPED_TABLES.filter((t) => PRESERVED_TABLES.has(t.table));
    expect(conflicts).toEqual([]);
  });
});
