#!/usr/bin/env node

import pg from "../../services/api/node_modules/pg/lib/index.js";
import { TENANT_SCOPED_TABLES } from "../../services/api/dist/tenant-deletion/service.js";
import { assertTenantDeletionPrivilegeContract } from "../../services/api/dist/tenant-deletion/privilege-contract.js";

const { Pool } = pg;

const databaseUrl = process.env.BRAIN_TENANT_DELETION_DB_URL;
if (typeof databaseUrl !== "string" || databaseUrl.length === 0) {
  throw new Error("BRAIN_TENANT_DELETION_DB_URL is required");
}

const pool = new Pool({ connectionString: databaseUrl, max: 1 });
const client = await pool.connect();
try {
  await client.query("BEGIN TRANSACTION READ ONLY");
  await client.query("SET LOCAL statement_timeout = '30s'");
  await client.query("SET LOCAL lock_timeout = '1s'");
  const report = await assertTenantDeletionPrivilegeContract(
    client,
    TENANT_SCOPED_TABLES.map(({ table }) => table),
  );
  await client.query("COMMIT");
  console.log(
    JSON.stringify({
      event: "commercial_demo_retirement_privilege_preflight_passed",
      ...report,
    }),
  );
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}
