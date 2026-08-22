#!/usr/bin/env node
import { Pool } from "pg";
import { seedNorthstarHistoricalSources } from "./historical-sources.js";

const databaseUrl = process.env["DATABASE_URL"];
const tenantId = process.env["BRAIN_TENANT_ID"];

if (databaseUrl === undefined || tenantId === undefined) {
  throw new Error("DATABASE_URL and BRAIN_TENANT_ID are required");
}

const pool = new Pool({ connectionString: databaseUrl });
try {
  const result = await seedNorthstarHistoricalSources(pool, tenantId);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await pool.end();
}
