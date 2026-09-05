import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client, Pool, type PoolClient } from "pg";
import { deleteTableInBatches, lockCandidateTenants } from "./batched-delete.js";
import {
  captureTenantReconciliationCounts,
  COMMERCIAL_DEMO_RETIREMENT_OPERATION_ID,
  initializeRetirementProgress,
  runRetirementTenantAttempt,
  tenantReconciliationCountStatement,
} from "./per-tenant-retirement.js";

const OWNER_DB_URL = process.env.DATABASE_URL;
const DELETION_DB_URL = process.env.DATABASE_URL_TENANT_DELETION;
const suite =
  OWNER_DB_URL !== undefined &&
  OWNER_DB_URL !== "" &&
  DELETION_DB_URL !== undefined &&
  DELETION_DB_URL !== ""
    ? describe.sequential
    : describe.skip;

suite("bounded tenant deletion transaction behavior", () => {
  let ownerPool: Pool;
  let deletionPool: Pool;
  let schema: string;

  beforeAll(async () => {
    schema = `bounded_delete_${createHash("sha1")
      .update(`${process.pid}:${Date.now()}`)
      .digest("hex")
      .slice(0, 12)}`;
    const bootstrap = new Client({ connectionString: OWNER_DB_URL });
    await bootstrap.connect();
    await bootstrap.query(`CREATE SCHEMA ${schema}`);
    await bootstrap.query(`CREATE TABLE ${schema}.retirement_targets (
      tenant_id text PRIMARY KEY
    )`);
    await bootstrap.query(`CREATE TABLE ${schema}.retirement_test_rows (
      id bigserial PRIMARY KEY,
      tenant_id text NOT NULL,
      payload text NOT NULL
    )`);
    await bootstrap.query(`CREATE TABLE ${schema}.tenants (
      id text PRIMARY KEY
    )`);
    await bootstrap.query(`CREATE TABLE ${schema}.audit_events (
      id bigserial PRIMARY KEY,
      tenant_id text NOT NULL,
      payload text NOT NULL
    )`);
    await bootstrap.query(
      `CREATE INDEX audit_events_tenant_id_idx ON ${schema}.audit_events (tenant_id)`,
    );
    await bootstrap.query(`CREATE TABLE ${schema}.commercial_demo_retirement_progress (
      operation_id text NOT NULL,
      tenant_id text NOT NULL,
      candidate_list_sha256 text NOT NULL,
      ordinal integer NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      attempt_count integer NOT NULL DEFAULT 0,
      expected_rows jsonb NOT NULL,
      deleted_rows jsonb,
      total_rows_deleted bigint,
      blob_purge_job_id text,
      blob_artifact_count integer,
      first_started_at timestamptz,
      last_attempt_at timestamptz,
      committed_at timestamptz,
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (operation_id, tenant_id),
      UNIQUE (operation_id, ordinal)
    )`);
    await bootstrap.query(`GRANT USAGE ON SCHEMA ${schema} TO brain_tenant_deletion`);
    await bootstrap.query(`GRANT SELECT ON ${schema}.retirement_targets TO brain_tenant_deletion`);
    await bootstrap.query(
      `GRANT SELECT, DELETE ON ${schema}.retirement_test_rows TO brain_tenant_deletion`,
    );
    await bootstrap.query(
      `GRANT SELECT, UPDATE, DELETE ON ${schema}.tenants TO brain_tenant_deletion`,
    );
    await bootstrap.query(`GRANT SELECT ON ${schema}.audit_events TO brain_tenant_deletion`);
    await bootstrap.query(
      `GRANT SELECT, INSERT, UPDATE ON ${schema}.commercial_demo_retirement_progress
       TO brain_tenant_deletion`,
    );
    await bootstrap.end();

    const ownerUrl = new URL(OWNER_DB_URL as string);
    ownerUrl.searchParams.set("options", `-csearch_path=${schema},public`);
    ownerPool = new Pool({
      connectionString: ownerUrl.toString(),
      max: 4,
      application_name: `${schema}_owner`,
    });
    const deletionUrl = new URL(DELETION_DB_URL as string);
    deletionUrl.searchParams.set("options", `-csearch_path=${schema},public`);
    deletionPool = new Pool({
      connectionString: deletionUrl.toString(),
      max: 4,
      application_name: `${schema}_deletion`,
    });
  });

  beforeEach(async () => {
    await ownerPool.query(
      `TRUNCATE retirement_test_rows, retirement_targets, tenants,
         audit_events, commercial_demo_retirement_progress RESTART IDENTITY`,
    );
    await ownerPool.query("GRANT UPDATE ON tenants TO brain_tenant_deletion");
    await ownerPool.query("INSERT INTO retirement_targets (tenant_id) VALUES ('target')");
  });

  afterAll(async () => {
    if (deletionPool !== undefined) await deletionPool.end();
    if (ownerPool !== undefined) await ownerPool.end();
    if (schema !== undefined && OWNER_DB_URL !== undefined) {
      const teardown = new Client({ connectionString: OWNER_DB_URL });
      await teardown.connect();
      await teardown.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await teardown.end();
    }
  });

  async function rollback(client: PoolClient): Promise<void> {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }

  it("runs deletion operations as the non-owner, non-superuser deletion role", async () => {
    const result = await deletionPool.query<{
      role: string;
      superuser: boolean;
      table_owner: string;
    }>(
      `SELECT current_user AS role,
              role.rolsuper AS superuser,
              pg_get_userbyid(relation.relowner) AS table_owner
         FROM pg_roles role
         JOIN pg_class relation ON relation.relname = 'tenants'
         JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE role.rolname = current_user
          AND namespace.nspname = current_schema()`,
    );
    expect(result.rows[0]).toEqual({
      role: "brain_tenant_deletion",
      superuser: false,
      table_owner: "brain",
    });
  });

  it("uses the audit-events tenant index for per-tenant reconciliation", async () => {
    await ownerPool.query(
      `INSERT INTO audit_events (tenant_id, payload)
       SELECT CASE WHEN value <= 10 THEN 'target' ELSE 'bystander' END,
              repeat('x', 64)
         FROM generate_series(1, 100000) value`,
    );
    await ownerPool.query("VACUUM ANALYZE audit_events");

    const deleter = await deletionPool.connect();
    try {
      await deleter.query("BEGIN TRANSACTION READ ONLY");
      const identity = await deleter.query<{ role: string; superuser: boolean }>(
        `SELECT current_user AS role, role.rolsuper AS superuser
           FROM pg_roles role
          WHERE role.rolname = current_user`,
      );
      expect(identity.rows[0]).toEqual({ role: "brain_tenant_deletion", superuser: false });
      await expect(
        captureTenantReconciliationCounts(
          deleter,
          [{ table: "audit_events", column: "tenant_id" }],
          "target",
        ),
      ).resolves.toEqual({ audit_events: 10 });

      const explained = await deleter.query<{ "QUERY PLAN": Array<Record<string, unknown>> }>(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
         ${tenantReconciliationCountStatement("audit_events", "tenant_id")}`,
        ["target"],
      );
      const root = explained.rows[0]?.["QUERY PLAN"]?.[0]?.Plan as
        | Record<string, unknown>
        | undefined;
      expect(root).toBeDefined();
      const nodes: Array<Record<string, unknown>> = [];
      const visit = (node: Record<string, unknown>): void => {
        nodes.push(node);
        for (const child of (node.Plans as Array<Record<string, unknown>> | undefined) ?? []) {
          visit(child);
        }
      };
      visit(root as Record<string, unknown>);
      expect(
        nodes.some(
          (node) =>
            node["Relation Name"] === "audit_events" &&
            typeof node["Node Type"] === "string" &&
            node["Node Type"].includes("Index"),
        ),
      ).toBe(true);
      expect(
        nodes.some(
          (node) => node["Relation Name"] === "audit_events" && node["Node Type"] === "Seq Scan",
        ),
      ).toBe(false);
      await deleter.query("ROLLBACK");
    } finally {
      await rollback(deleter);
    }
  });

  it("deletes more than one batch and commits only the target rows", async () => {
    await ownerPool.query(
      `INSERT INTO retirement_test_rows (tenant_id, payload)
       SELECT 'target', value::text FROM generate_series(1, 7) value
       UNION ALL SELECT 'bystander', 'keep'`,
    );
    const client = await deletionPool.connect();
    try {
      await client.query("BEGIN");
      const deleted = await deleteTableInBatches(client, {
        table: "retirement_test_rows",
        column: "tenant_id",
        expectedRows: 7,
        batchSize: 2,
      });
      expect(deleted).toBe(7);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const remaining = await ownerPool.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM retirement_test_rows ORDER BY tenant_id",
    );
    expect(remaining.rows).toEqual([{ tenant_id: "bystander" }]);
  });

  it("rolls back every earlier batch after an injected mid-table failure", async () => {
    await ownerPool.query(
      `INSERT INTO retirement_test_rows (tenant_id, payload)
       SELECT 'target', value::text FROM generate_series(1, 5) value`,
    );
    const client = await deletionPool.connect();
    try {
      await client.query("BEGIN");
      await expect(
        deleteTableInBatches(client, {
          table: "retirement_test_rows",
          column: "tenant_id",
          expectedRows: 5,
          batchSize: 2,
          afterBatch: ({ batch }) => {
            if (batch === 2) throw new Error("injected mid-table failure");
          },
        }),
      ).rejects.toThrow("injected mid-table failure");
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    const remaining = await ownerPool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM retirement_test_rows",
    );
    expect(remaining.rows[0]?.count).toBe("5");
  });

  it("does not hide a row inserted after the captured preflight count", async () => {
    await ownerPool.query(
      `INSERT INTO retirement_test_rows (tenant_id, payload)
       VALUES ('target', 'before-1'), ('target', 'before-2')`,
    );
    const deleter = await deletionPool.connect();
    try {
      await deleter.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      const preflight = await deleter.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM retirement_test_rows WHERE tenant_id = 'target'",
      );
      expect(preflight.rows[0]?.count).toBe("2");

      await ownerPool.query(
        "INSERT INTO retirement_test_rows (tenant_id, payload) VALUES ('target', 'after-preflight')",
      );
      await expect(
        deleteTableInBatches(deleter, {
          table: "retirement_test_rows",
          column: "tenant_id",
          expectedRows: 2,
          batchSize: 10,
        }),
      ).rejects.toThrow("expected 2, got at least 3");
      await deleter.query("ROLLBACK");
    } finally {
      deleter.release();
    }

    const remaining = await ownerPool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM retirement_test_rows",
    );
    expect(remaining.rows[0]?.count).toBe("3");
  });

  it("fails closed on lock_timeout and rolls back an earlier batch", async () => {
    await ownerPool.query(
      `INSERT INTO retirement_test_rows (tenant_id, payload)
       VALUES ('target', 'first'), ('target', 'locked')`,
    );
    const locker = await ownerPool.connect();
    const deleter = await deletionPool.connect();
    try {
      await locker.query("BEGIN");
      await locker.query("SELECT 1 FROM retirement_test_rows WHERE id = 2 FOR UPDATE");

      await deleter.query("BEGIN");
      await deleter.query("SET LOCAL statement_timeout = '2s'");
      await deleter.query("SET LOCAL lock_timeout = '100ms'");
      let code: string | undefined;
      try {
        await deleteTableInBatches(deleter, {
          table: "retirement_test_rows",
          column: "tenant_id",
          expectedRows: 2,
          batchSize: 1,
        });
      } catch (error) {
        code = (error as { code?: string }).code;
      }
      expect(code).toBe("55P03");
      await deleter.query("ROLLBACK");
      await locker.query("ROLLBACK");
    } finally {
      await rollback(deleter);
      await rollback(locker);
    }

    const remaining = await ownerPool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM retirement_test_rows",
    );
    expect(remaining.rows[0]?.count).toBe("2");
  });

  it("rolls back an earlier batch when statement_timeout wins a lock conflict", async () => {
    await ownerPool.query(
      `INSERT INTO retirement_test_rows (tenant_id, payload)
       VALUES ('target', 'first'), ('target', 'locked')`,
    );
    const locker = await ownerPool.connect();
    const deleter = await deletionPool.connect();
    try {
      await locker.query("BEGIN");
      await locker.query("SELECT 1 FROM retirement_test_rows WHERE id = 2 FOR UPDATE");

      await deleter.query("BEGIN");
      await deleter.query("SET LOCAL statement_timeout = '200ms'");
      await deleter.query("SET LOCAL lock_timeout = '0'");
      let code: string | undefined;
      try {
        await deleteTableInBatches(deleter, {
          table: "retirement_test_rows",
          column: "tenant_id",
          expectedRows: 2,
          batchSize: 1,
        });
      } catch (error) {
        code = (error as { code?: string }).code;
      }
      expect(code).toBe("57014");
      await deleter.query("ROLLBACK");
      await locker.query("ROLLBACK");
    } finally {
      await rollback(deleter);
      await rollback(locker);
    }

    const remaining = await ownerPool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM retirement_test_rows",
    );
    expect(remaining.rows[0]?.count).toBe("2");
  });

  it("locks candidates and completes the full bounded tenant path as the deletion role", async () => {
    await ownerPool.query("INSERT INTO tenants (id) VALUES ('target'), ('bystander')");
    await ownerPool.query(
      `INSERT INTO retirement_test_rows (tenant_id, payload)
       VALUES ('target', 'delete'), ('bystander', 'keep')`,
    );
    const deleter = await deletionPool.connect();
    try {
      await deleter.query("BEGIN");
      await lockCandidateTenants(deleter, 1);
      await deleteTableInBatches(deleter, {
        table: "retirement_test_rows",
        column: "tenant_id",
        expectedRows: 1,
        batchSize: 1,
      });
      await deleteTableInBatches(deleter, {
        table: "tenants",
        column: "id",
        expectedRows: 1,
        batchSize: 1,
      });
      await deleter.query("COMMIT");
    } finally {
      deleter.release();
    }
    const remainingTenants = await ownerPool.query<{ id: string }>(
      "SELECT id FROM tenants ORDER BY id",
    );
    expect(remainingTenants.rows).toEqual([{ id: "bystander" }]);
  });

  it("fails the exact candidate lock when tenants UPDATE is absent", async () => {
    await ownerPool.query("INSERT INTO tenants (id) VALUES ('target')");
    await ownerPool.query("REVOKE UPDATE ON tenants FROM brain_tenant_deletion");
    const deleter = await deletionPool.connect();
    try {
      await deleter.query("BEGIN");
      await expect(lockCandidateTenants(deleter, 1)).rejects.toMatchObject({ code: "42501" });
      await deleter.query("ROLLBACK");
    } finally {
      await ownerPool.query("GRANT UPDATE ON tenants TO brain_tenant_deletion");
      deleter.release();
    }
  });

  it("commits one tenant at a time and resumes without repeating completed work", async () => {
    await ownerPool.query("INSERT INTO tenants (id) VALUES ('target-one'), ('target-two')");
    await ownerPool.query(
      `INSERT INTO retirement_test_rows (tenant_id, payload)
       VALUES ('target-one', 'delete-one'), ('target-two', 'delete-two')`,
    );
    const setup = await deletionPool.connect();
    try {
      await setup.query("BEGIN");
      await initializeRetirementProgress(setup, "a".repeat(64), [
        {
          tenantId: "target-one",
          ordinal: 1,
          expectedRows: { retirement_test_rows: 1, tenants: 1 },
        },
        {
          tenantId: "target-two",
          ordinal: 2,
          expectedRows: { retirement_test_rows: 1, tenants: 1 },
        },
      ]);
      await setup.query("COMMIT");
    } finally {
      setup.release();
    }

    const execute = async (
      client: PoolClient,
      tenantId: string,
      expectedRows: Record<string, number>,
      fail: boolean,
    ) => {
      const rows = await client.query("DELETE FROM retirement_test_rows WHERE tenant_id = $1", [
        tenantId,
      ]);
      expect(rows.rowCount).toBe(expectedRows.retirement_test_rows);
      if (fail) throw new Error("injected tenant failure");
      const tenants = await client.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
      expect(tenants.rowCount).toBe(expectedRows.tenants);
      return {
        deletedRows: { retirement_test_rows: 1, tenants: 1 },
        totalRowsDeleted: 2,
        blobPurgeJobId: null,
        blobArtifactCount: 0,
      };
    };

    const first = await runRetirementTenantAttempt(deletionPool, "target-one", (client, counts) =>
      execute(client, "target-one", counts, false),
    );
    const failed = await runRetirementTenantAttempt(deletionPool, "target-two", (client, counts) =>
      execute(client, "target-two", counts, true),
    );
    expect(first.status).toBe("completed");
    expect(failed).toMatchObject({ status: "failed", error: "injected tenant failure" });
    expect(
      await ownerPool.query("SELECT id FROM tenants ORDER BY id").then(({ rows }) => rows),
    ).toEqual([{ id: "target-two" }]);
    expect(
      await ownerPool
        .query("SELECT tenant_id FROM retirement_test_rows ORDER BY tenant_id")
        .then(({ rows }) => rows),
    ).toEqual([{ tenant_id: "target-two" }]);

    const skipped = await runRetirementTenantAttempt(deletionPool, "target-one", () => {
      throw new Error("completed tenant must not execute again");
    });
    const resumed = await runRetirementTenantAttempt(deletionPool, "target-two", (client, counts) =>
      execute(client, "target-two", counts, false),
    );
    expect(skipped.status).toBe("skipped");
    expect(resumed.status).toBe("completed");
    const progress = await ownerPool.query(
      `SELECT tenant_id, status, attempt_count
         FROM commercial_demo_retirement_progress
        WHERE operation_id = $1
        ORDER BY ordinal`,
      [COMMERCIAL_DEMO_RETIREMENT_OPERATION_ID],
    );
    expect(progress.rows).toEqual([
      { tenant_id: "target-one", status: "completed", attempt_count: 1 },
      { tenant_id: "target-two", status: "completed", attempt_count: 2 },
    ]);
  });

  it("rolls back a tenant when its total transaction duration exceeds the cap", async () => {
    await ownerPool.query("INSERT INTO tenants (id) VALUES ('target')");
    await ownerPool.query(
      "INSERT INTO retirement_test_rows (tenant_id, payload) VALUES ('target', 'keep-on-timeout')",
    );
    const setup = await deletionPool.connect();
    try {
      await setup.query("BEGIN");
      await initializeRetirementProgress(setup, "b".repeat(64), [
        {
          tenantId: "target",
          ordinal: 1,
          expectedRows: { retirement_test_rows: 1, tenants: 1 },
        },
      ]);
      await setup.query("COMMIT");
    } finally {
      setup.release();
    }
    const result = await runRetirementTenantAttempt(
      deletionPool,
      "target",
      async (client) => {
        await client.query("DELETE FROM retirement_test_rows WHERE tenant_id = 'target'");
        return {
          deletedRows: { retirement_test_rows: 1, tenants: 0 },
          totalRowsDeleted: 1,
          blobPurgeJobId: null,
          blobArtifactCount: 0,
        };
      },
      { maxDurationMs: -1 },
    );
    expect(result.status).toBe("failed");
    expect(result.error).toContain("tenant retirement exceeded");
    const rows = await ownerPool.query("SELECT payload FROM retirement_test_rows");
    expect(rows.rows).toEqual([{ payload: "keep-on-timeout" }]);
  });
});
