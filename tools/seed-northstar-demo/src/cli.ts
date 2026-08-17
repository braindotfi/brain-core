#!/usr/bin/env node
import { Pool } from "pg";
import { seedNorthstarDemo } from "./index.js";

const databaseUrl = process.env["DATABASE_URL"];
const tenantId = process.env["BRAIN_TENANT_ID"];
const actor = process.env["BRAIN_ACTOR"];

if (databaseUrl === undefined || tenantId === undefined || actor === undefined) {
  throw new Error("DATABASE_URL, BRAIN_TENANT_ID, and BRAIN_ACTOR are required");
}

const pool = new Pool({ connectionString: databaseUrl });
try {
  const result = await seedNorthstarDemo(pool, tenantId, actor);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await pool.end();
}
