import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client, Pool, type PoolClient } from "pg";
import { deleteTableInBatches, lockCandidateTenants } from "./batched-delete.js";

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
    await bootstrap.query(`GRANT USAGE ON SCHEMA ${schema} TO brain_tenant_deletion`);
    await bootstrap.query(`GRANT SELECT ON ${schema}.retirement_targets TO brain_tenant_deletion`);
    await bootstrap.query(
      `GRANT SELECT, DELETE ON ${schema}.retirement_test_rows TO brain_tenant_deletion`,
    );
    await bootstrap.query(
      `GRANT SELECT, UPDATE, DELETE ON ${schema}.tenants TO brain_tenant_deletion`,
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
      "TRUNCATE retirement_test_rows, retirement_targets, tenants RESTART IDENTITY",
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
});
