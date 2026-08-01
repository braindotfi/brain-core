#!/usr/bin/env node
/**
 * Tenant-table RLS coverage guard.
 *
 * Every service-owned table with a tenant_id column must have RLS enabled,
 * forced, and covered by at least one policy. The check scans all service
 * migrations as a set so later FORCE or policy migrations count for tables
 * created earlier.
 *
 * Run: pnpm run check-rls-coverage
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RLS_ALLOWLIST = {
  audit_verifier_checkpoint:
    "BYPASSRLS-only operator checkpoint table with no tenant_id column; never read on a tenant request path.",
};

const ROOT = process.env.BRAIN_RLS_GUARD_ROOT ?? process.cwd();

export function analyzeRlsCoverage(root, allowlist = RLS_ALLOWLIST) {
  const allowlistFailures = validateAllowlist(allowlist);
  const migrations = loadMigrationFiles(root);
  const corpus = stripSqlComments(migrations.map((m) => m.sql).join("\n"));
  const tenantTables = collectTenantTables(migrations);
  const violations = [...allowlistFailures];

  for (const table of [...tenantTables].sort()) {
    const reason = allowlist[table];
    if (typeof reason === "string" && reason.trim().length > 0) continue;
    const coverage = tableCoverage(corpus, table);
    const missing = [];
    if (!coverage.enable) missing.push("ENABLE");
    if (!coverage.force) missing.push("FORCE");
    if (!coverage.policy) missing.push("POLICY");
    if (missing.length > 0) {
      violations.push({
        table,
        missing,
        detail: `missing ${missing.join(", ")}`,
      });
    }
  }

  return {
    ok: violations.length === 0,
    tenantTables,
    violations,
  };
}

export function collectTenantTables(migrations) {
  const tables = new Set();
  for (const migration of migrations) {
    const sql = stripSqlComments(migration.sql);
    for (const match of sql.matchAll(
      /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?<table>(?:"[^"]+"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][\w$]*))?)\s*\((?<body>[\s\S]*?)\)\s*;/gi,
    )) {
      const table = normalizeTableName(match.groups?.table ?? "");
      const body = match.groups?.body ?? "";
      if (table !== "" && declaresTenantId(body)) tables.add(table);
    }

    for (const match of sql.matchAll(
      /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?<table>(?:"[^"]+"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][\w$]*))?)\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?tenant_id"?\b/gi,
    )) {
      const table = normalizeTableName(match.groups?.table ?? "");
      if (table !== "") tables.add(table);
    }
  }
  return tables;
}

export function tableCoverage(corpus, table) {
  const name = tableRegex(table);
  return {
    enable: new RegExp(
      `\\bALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?${name}\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY\\b`,
      "i",
    ).test(corpus),
    force: new RegExp(
      `\\bALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?${name}\\s+FORCE\\s+ROW\\s+LEVEL\\s+SECURITY\\b`,
      "i",
    ).test(corpus),
    policy: new RegExp(`\\bCREATE\\s+POLICY\\s+[^;]+?\\bON\\s+${name}\\b`, "i").test(corpus),
  };
}

function loadMigrationFiles(root) {
  const servicesDir = join(root, "services");
  if (!existsSync(servicesDir)) return [];
  const out = [];
  for (const service of readdirSync(servicesDir).sort()) {
    const migrationsDir = join(servicesDir, service, "migrations");
    if (!existsSync(migrationsDir) || !statSync(migrationsDir).isDirectory()) continue;
    for (const entry of readdirSync(migrationsDir).sort()) {
      if (!entry.endsWith(".sql")) continue;
      const path = join(migrationsDir, entry);
      out.push({
        path,
        rel: relative(root, path),
        sql: readFileSync(path, "utf8"),
      });
    }
  }
  return out;
}

function validateAllowlist(allowlist) {
  const failures = [];
  for (const [table, reason] of Object.entries(allowlist)) {
    if (typeof reason !== "string" || reason.trim().length === 0) {
      failures.push({
        table,
        missing: ["ALLOWLIST_REASON"],
        detail: "allowlist entry requires a human-readable reason",
      });
    }
  }
  return failures;
}

function stripSqlComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n\r]*/g, " ");
}

function declaresTenantId(createTableBody) {
  return /(?:^|,)\s*"?tenant_id"?\s+/i.test(createTableBody);
}

function normalizeTableName(raw) {
  const parts = raw
    .split(".")
    .map((p) => p.trim().replace(/^"|"$/g, "").toLowerCase())
    .filter(Boolean);
  return parts.at(-1) ?? "";
}

function tableRegex(table) {
  const escaped = escapeRegex(table);
  const quoted = `"${escapeRegex(table)}"`;
  return `(?:(?:"[^"]+"|[A-Za-z_][\\w$]*)\\s*\\.\\s*)?(?:${escaped}|${quoted})`;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function main() {
  const result = analyzeRlsCoverage(ROOT);
  if (!result.ok) {
    console.error("rls-coverage guard: FAIL");
    for (const violation of result.violations) {
      console.error(`  ${violation.table}: ${violation.detail}`);
    }
    console.error(
      "\nEvery service-owned table with tenant_id must ENABLE and FORCE ROW LEVEL SECURITY" +
        "\nand define at least one tenant policy. If a table is intentionally exempt," +
        "\nadd it to RLS_ALLOWLIST with a human-readable reason.",
    );
    process.exit(1);
  }
  console.log(`rls-coverage guard: OK (${result.tenantTables.size} tenant table(s) covered)`);
}

const invokedPath = process.argv[1] === undefined ? "" : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  main();
}
