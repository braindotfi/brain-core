/**
 * Auth (Phase 2a) integration-test harness.
 *
 * Mirrors services/raw/src/__integration__/harness.ts (the only other
 * integration harness in the repo): a fresh per-run schema, migrations
 * applied through the real runner, DATABASE_URL owner pool. No app is built
 * here (Phase 2a ships no HTTP routes yet), so this harness is deliberately
 * smaller than raw's.
 *
 * Requires a live Postgres reachable via DATABASE_URL. Skips (returns null)
 * if the env var is unset, matching every other __integration__ suite.
 */

import { createHash } from "node:crypto";
import { Client, Pool } from "pg";
import { applyAll, discoverMigrations } from "../../../../tools/migrate/src/index.js";

export interface AuthHarness {
  schema: string;
  /** Owner connection (DATABASE_URL). Bypasses RLS -- use only for seeding. */
  pool: Pool;
  cleanup: () => Promise<void>;
}

export async function buildAuthHarness(): Promise<AuthHarness | null> {
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl === undefined || dbUrl === "") return null;

  const schema = `brain_test_auth_${createHash("sha1")
    .update(String(process.pid) + String(Date.now()) + String(Math.random()))
    .digest("hex")
    .slice(0, 12)}`;

  const bootstrap = new Client({ connectionString: dbUrl });
  await bootstrap.connect();
  await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await bootstrap.end();

  const pool = new Pool({
    connectionString: dbUrl,
    max: 5,
    application_name: `brain-auth-test-${schema}`,
  });
  pool.on("connect", (c) => {
    void c.query(`SET search_path TO ${schema}, public`);
  });

  const migClient = await pool.connect();
  try {
    await migClient.query(`SET search_path TO ${schema}, public`);
    const discovered = await discoverMigrations(findRepoRoot());
    await applyAll(migClient as unknown as Parameters<typeof applyAll>[0], discovered, {
      appliedBy: "auth-integration-test",
    });
  } finally {
    migClient.release();
  }

  async function cleanup(): Promise<void> {
    await pool.end();
    const done = new Client({ connectionString: dbUrl });
    await done.connect();
    await done.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await done.end();
  }

  return { schema, pool, cleanup };
}

function findRepoRoot(): string {
  // Integration tests run from services/auth/test/__integration__ -- repo
  // root is four levels up (same depth as services/raw/src/__integration__).
  return new URL("../../../..", import.meta.url).pathname;
}
