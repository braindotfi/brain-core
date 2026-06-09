/**
 * Invariant (§1): tenant isolation at the storage layer. Every Postgres table
 * that carries a `tenant_id` column MUST enable row-level security — a missing
 * RLS policy is the "shared-query-with-filter" pattern §1 forbids.
 *
 * This is a static scan of all migration SQL, so it runs DB-free on every PR
 * and catches the gap at author time. Legitimate cross-tenant readers (the
 * normalize worker, the Plaid webhook tenant resolver) run under a BYPASSRLS
 * role; RLS on the table is the defense-in-depth backstop for request-path
 * connections.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const servicesDir = resolve(here, "../../..", "services");

function allMigrationSql(): string {
  const parts: string[] = [];
  for (const service of readdirSync(servicesDir)) {
    const migDir = join(servicesDir, service, "migrations");
    if (!existsSync(migDir)) continue;
    for (const file of readdirSync(migDir)) {
      if (file.endsWith(".sql")) parts.push(readFileSync(join(migDir, file), "utf8"));
    }
  }
  return parts.join("\n");
}

function tablesWithTenantId(sql: string): Set<string> {
  const out = new Set<string>();
  const re = /CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\(([\s\S]*?)\n\s*\);/gi;
  for (const m of sql.matchAll(re)) {
    const name = m[1];
    const body = m[2];
    if (name !== undefined && body !== undefined && /\btenant_id\b/.test(body)) {
      out.add(name.toLowerCase());
    }
  }
  return out;
}

function tablesWithRls(sql: string): Set<string> {
  const out = new Set<string>();
  for (const m of sql.matchAll(/ALTER TABLE (\w+)\s+ENABLE ROW LEVEL SECURITY/gi)) {
    const name = m[1];
    if (name !== undefined) out.add(name.toLowerCase());
  }
  return out;
}

/**
 * Tables that carry a `tenant_id` *reference* column but are deliberately NOT
 * tenant-RLS-scoped because they hold privileged verifier/forensic state rather
 * than tenant request-path data. Every entry MUST be justified by a migration
 * comment documenting the privileged-only access model.
 */
const PRIVILEGED_NON_RLS_TABLES = new Set<string>([
  // services/audit/migrations/0011_audit_integrity_findings.sql:
  // "Verifier state, not tenant data: no RLS (only the privileged verifier writes)."
  "audit_integrity_findings",
]);

describe("invariant: every tenant-scoped table enables row-level security (§1)", () => {
  it("no table with a tenant_id column is missing RLS", () => {
    const sql = allMigrationSql();
    const withTenant = tablesWithTenantId(sql);
    const withRls = tablesWithRls(sql);
    const missing = [...withTenant]
      .filter((t) => !withRls.has(t) && !PRIVILEGED_NON_RLS_TABLES.has(t))
      .sort();
    expect(missing, `tables with tenant_id but no RLS: ${missing.join(", ") || "(none)"}`).toEqual(
      [],
    );
  });
});
