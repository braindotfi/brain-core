#!/usr/bin/env node
/**
 * Policy-no-Wiki-read guard.
 *
 * Brain_MVP_Architecture.md §1.5 / §"Per-Layer Must Not": Policy evaluates
 * machine-readable Ledger state, NEVER narrative Wiki text. The §6 gate forbids
 * a Wiki read on the money path; this guard makes the rule static.
 *
 * Catches both vectors: importing @brain/wiki, and raw SQL against wiki_* tables.
 *
 * Run: pnpm run check-policy-no-wiki-read
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_SCAN_DIR = "services/policy/src";

const WIKI_IMPORT = /from\s+["']@brain\/wiki["']/;
const WIKI_SQL = /(FROM|INTO|UPDATE|JOIN)\s+wiki_[a-z_]+/is;

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
    content.split("\n").forEach((line, i) => {
      if (WIKI_IMPORT.test(line)) {
        violations.push(`${file}:${i + 1}: Policy imports from @brain/wiki`);
      }
    });
    if (WIKI_SQL.test(content)) {
      const m = content.match(WIKI_SQL);
      violations.push(`${file}: Policy SQL references a wiki_* table (${m?.[0]?.trim()})`);
    }
  }
  return violations;
}

function main() {
  const scanDir = process.argv[2] ?? DEFAULT_SCAN_DIR;
  const violations = findViolations(scanDir);
  if (violations.length > 0) {
    console.error("Policy must not read Wiki (machine truth comes from Ledger):");
    for (const v of violations) console.error(`  ${v}`);
    process.exit(1);
  }
  console.log("policy-no-wiki-read guard: OK");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
