import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { analyzeRlsCoverage } from "../check-rls-coverage.mjs";

function withMigrations(files, fn) {
  const root = mkdtempSync(join(tmpdir(), "rls-coverage-"));
  try {
    for (const [rel, contents] of Object.entries(files)) {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, contents);
    }
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("reports a tenant_id table with no RLS policy coverage", () => {
  const result = withMigrations(
    {
      "services/demo/migrations/0001.sql": `
        CREATE TABLE demo_records (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL
        );
      `,
    },
    (root) => analyzeRlsCoverage(root, {}),
  );

  assert.equal(result.ok, false);
  assert.deepEqual(result.violations, [
    {
      table: "demo_records",
      missing: ["ENABLE", "FORCE", "POLICY"],
      detail: "missing ENABLE, FORCE, POLICY",
    },
  ]);
});

test("passes when RLS coverage is split across later migration files", () => {
  const result = withMigrations(
    {
      "services/demo/migrations/0001.sql": `
        CREATE TABLE demo_records (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL
        );
      `,
      "services/demo/migrations/0002.sql": `
        ALTER TABLE demo_records ENABLE ROW LEVEL SECURITY;
        CREATE POLICY tenant_isolation ON demo_records
          USING (tenant_id = current_setting('app.tenant_id', true));
      `,
      "services/demo/migrations/0003.sql": `
        ALTER TABLE demo_records FORCE ROW LEVEL SECURITY;
      `,
    },
    (root) => analyzeRlsCoverage(root, {}),
  );

  assert.equal(result.ok, true);
  assert.deepEqual([...result.tenantTables], ["demo_records"]);
});

test("detects tenant_id added by ALTER TABLE ADD COLUMN", () => {
  const result = withMigrations(
    {
      "services/demo/migrations/0001.sql": `
        CREATE TABLE demo_records (
          id TEXT PRIMARY KEY
        );
        ALTER TABLE demo_records ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL;
      `,
    },
    (root) => analyzeRlsCoverage(root, {}),
  );

  assert.equal(result.ok, false);
  assert.equal(result.violations[0]?.table, "demo_records");
});

test("fails an allowlist entry without a human-readable reason", () => {
  const result = withMigrations({}, (root) =>
    analyzeRlsCoverage(root, {
      operator_table: "",
    }),
  );

  assert.equal(result.ok, false);
  assert.deepEqual(result.violations, [
    {
      table: "operator_table",
      missing: ["ALLOWLIST_REASON"],
      detail: "allowlist entry requires a human-readable reason",
    },
  ]);
});
