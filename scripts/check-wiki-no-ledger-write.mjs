#!/usr/bin/env node
/**
 * Wiki-no-Ledger-write guard.
 *
 * The Wiki layer is a read-only projection of the Ledger (and reads only via
 * the sanctioned TenantScopedClient SELECTs). It must NEVER write Ledger state.
 * Brain_MVP_Architecture.md §"Per-Layer Must Not": Wiki is never the source of
 * truth for balances/obligations/transactions/permissions.
 *
 * Wiki accesses the database through raw SQL (not @brain/ledger imports), so
 * this guard catches BOTH vectors:
 *   1. importing a Ledger write helper from @brain/ledger, and
 *   2. raw INSERT/UPDATE/DELETE against any ledger_* table.
 *
 * Run: pnpm run check-wiki-no-ledger-write
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_SCAN_DIR = "services/wiki/src";

// A symbol imported from @brain/ledger whose name looks like a write op.
const LEDGER_IMPORT = /from\s+["']@brain\/ledger["']/;
const WRITE_SYMBOL = /^(insert|update|delete|transition|append|upsert|record)[A-Z]/;
// Raw SQL writes against a ledger_* table (multi-line tolerant).
const LEDGER_SQL_WRITE = /(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+ledger_[a-z_]+/is;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".ts") && !full.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/** Returns a list of "file:line: reason" violation strings (empty when clean). */
export function findViolations(scanDir) {
  const violations = [];
  for (const file of walk(scanDir)) {
    const content = readFileSync(file, "utf8");
    const lines = content.split("\n");

    // 1. Ledger write-helper imports.
    lines.forEach((line, i) => {
      if (!LEDGER_IMPORT.test(line)) return;
      const names = line.slice(line.indexOf("{") + 1, line.indexOf("}"));
      for (const raw of names.split(",")) {
        const name = raw.replace(/\s+as\s+\w+/, "").trim();
        if (WRITE_SYMBOL.test(name)) {
          violations.push(
            `${file}:${i + 1}: imports Ledger write helper '${name}' from @brain/ledger`,
          );
        }
      }
    });

    // 2. Raw SQL writes to ledger_* tables (scan whole file for multi-line SQL).
    if (LEDGER_SQL_WRITE.test(content)) {
      const m = content.match(LEDGER_SQL_WRITE);
      violations.push(`${file}: raw SQL write against a ledger_* table (${m?.[0]?.trim()})`);
    }
  }
  return violations;
}

function main() {
  const scanDir = process.argv[2] ?? DEFAULT_SCAN_DIR;
  const violations = findViolations(scanDir);
  if (violations.length > 0) {
    console.error("Wiki must not write Ledger state (read-only projection):");
    for (const v of violations) console.error(`  ${v}`);
    process.exit(1);
  }
  console.log("wiki-no-ledger-write guard: OK");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
