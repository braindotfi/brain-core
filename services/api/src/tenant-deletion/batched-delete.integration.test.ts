import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client, Pool, type PoolClient } from "pg";
import { deleteTableInBatches } from "./batched-delete.js";

const DB_URL = process.env.DATABASE_URL;
const suite = DB_URL !== undefined && DB_URL !== "" ? describe : describe.skip;

suite("bounded tenant deletion transaction behavior", () => {
  let pool: Pool;
  let schema: string;

  beforeAll(async () => {
    schema = `bounded_delete_${createHash("sha1")
      .update(`${process.pid}:${Date.now()}`)
      .digest("hex")
      .slice(0, 12)}`;
    const bootstrap = new Client({ connectionString: DB_URL });
    await bootstrap.connect();
    await bootstrap.query(`CREATE SCHEMA ${schema}`);
    await bootstrap.end();

    const scopedUrl = new URL(DB_URL as string);
    scopedUrl.searchParams.set("options", `-csearch_path=${schema},public`);
    pool = new Pool({ connectionString: scopedUrl.toString(), max: 4, application_name: schema });
    await pool.query(`CREATE TABLE retirement_targets (tenant_id text PRIMARY KEY)`);
    await pool.query(`CREATE TABLE retirement_test_rows (
      id bigserial PRIMARY KEY,
      tenant_id text NOT NULL,
      payload text NOT NULL
    )`);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE retirement_test_rows, retirement_targets RESTART IDENTITY");
    await pool.query("INSERT INTO retirement_targets (tenant_id) VALUES ('target')");
  });

  afterAll(async () => {
    if (pool !== undefined) await pool.end();
    if (schema !== undefined && DB_URL !== undefined) {
      const teardown = new Client({ connectionString: DB_URL });
      await teardown.connect();
      await teardown.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await teardown.end();
    }
  });

  async function rollback(client: PoolClient): Promise<void> {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }

  it("deletes more than one batch and commits only the target rows", async () => {
    await pool.query(
      `INSERT INTO retirement_test_rows (tenant_id, payload)
       SELECT 'target', value::text FROM generate_series(1, 7) value
       UNION ALL SELECT 'bystander', 'keep'`,
    );
    const client = await pool.connect();
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
    const remaining = await pool.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM retirement_test_rows ORDER BY tenant_id",
    );
    expect(remaining.rows).toEqual([{ tenant_id: "bystander" }]);
  });

  it("rolls back every earlier batch after an injected mid-table failure", async () => {
    await pool.query(
      `INSERT INTO retirement_test_rows (tenant_id, payload)
       SELECT 'target', value::text FROM generate_series(1, 5) value`,
    );
    const client = await pool.connect();
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
    const remaining = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM retirement_test_rows",
    );
    expect(remaining.rows[0]?.count).toBe("5");
  });

  it("does not hide a row inserted after the captured preflight count", async () => {
    await pool.query(
      `INSERT INTO retirement_test_rows (tenant_id, payload)
       VALUES ('target', 'before-1'), ('target', 'before-2')`,
    );
    const deleter = await pool.connect();
    try {
      await deleter.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      const preflight = await deleter.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM retirement_test_rows WHERE tenant_id = 'target'",
      );
      expect(preflight.rows[0]?.count).toBe("2");

      await pool.query(
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

    const remaining = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM retirement_test_rows",
    );
    expect(remaining.rows[0]?.count).toBe("3");
  });

  it("fails closed on lock_timeout and rolls back an earlier batch", async () => {
    await pool.query(
      `INSERT INTO retirement_test_rows (tenant_id, payload)
       VALUES ('target', 'first'), ('target', 'locked')`,
    );
    const locker = await pool.connect();
    const deleter = await pool.connect();
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

    const remaining = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM retirement_test_rows",
    );
    expect(remaining.rows[0]?.count).toBe("2");
  });

  it("rolls back an earlier batch when statement_timeout wins a lock conflict", async () => {
    await pool.query(
      `INSERT INTO retirement_test_rows (tenant_id, payload)
       VALUES ('target', 'first'), ('target', 'locked')`,
    );
    const locker = await pool.connect();
    const deleter = await pool.connect();
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

    const remaining = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM retirement_test_rows",
    );
    expect(remaining.rows[0]?.count).toBe("2");
  });
});
