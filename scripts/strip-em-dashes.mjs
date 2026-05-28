#!/usr/bin/env node
/**
 * De-em-dash all in-scope markdown files (project docs + GitBook).
 *
 * Em dashes (—, U+2014) are a strong AI-prose tell. This script replaces them
 * per context so the docs read like an engineer wrote them:
 *
 *   word—word        → word-word      (compound: convert to hyphen)
 *   "X — Y"          → "X. Y"         (sentence break: period + capitalise)
 *   " —" at line end → "."            (trailing aside)
 *   any remaining —  → ", "           (catch-all: comma)
 *
 * Two modes:
 *   --check  (default)  exit 1 if any in-scope file contains an em dash.
 *                       For use in `pnpm run lint`.
 *   --write             rewrite files in place; report counts.
 *
 * Scope: every .md file under the repo, excluding node_modules, .git, .claude
 * worktrees, dist/, .venv, hyper/ (separate Expo app), and CHANGELOG-shaped
 * vendor docs. Add per-path exclusions to SKIP_DIRS / SKIP_FILES below if more
 * are needed.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.cwd();
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".claude",
  "dist",
  ".venv",
  "venv",
  "__pycache__",
  "coverage",
  ".turbo",
  ".vitest-cache",
  ".pnpm-store",
  "hyper", // separate Expo app, not part of brain-core docs
]);

const EM_DASH = "—"; // —

function* walkMd(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walkMd(p);
    else if (st.isFile() && p.endsWith(".md")) yield p;
  }
}

/**
 * Apply the em-dash transforms in priority order.
 * Order matters: handle compound (no-space) before space-bounded forms,
 * so "word—word" becomes "word-word" and isn't caught by the comma catch-all.
 */
export function stripEmDashes(src) {
  let out = src;
  // 1. Em-dash between word characters → hyphen.  "M2M—commerce" → "M2M-commerce"
  out = out.replace(/(\w)—(\w)/g, "$1-$2");
  // 2. Em-dash with spaces on both sides → period + capitalise the next non-space char.
  out = out.replace(/ — (\S)/g, (_m, ch) => `. ${ch.toUpperCase()}`);
  // 3. Em-dash with leading space at end of line → period.
  out = out.replace(/ —(?=\n|$)/g, ".");
  // 4. Em-dash with leading space, trailing non-space, no trailing space (rare).
  out = out.replace(/ —/g, ".");
  // 5. Em-dash with trailing space only (rare).
  out = out.replace(/— /g, ", ");
  // 6. Any remaining em-dash (zero-spaces but not between word chars) → comma.
  out = out.replace(/—/g, ",");
  return out;
}

// CLI driver — guarded so a test/importer can pull in stripEmDashes without
// triggering the filesystem walk and process.exit.
const isCli = fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) {
  const args = new Set(process.argv.slice(2));
  const isWrite = args.has("--write");

  let filesScanned = 0;
  let filesWithEmDash = 0;
  let totalEmDashes = 0;
  const offenders = [];

  for (const file of walkMd(ROOT)) {
    filesScanned += 1;
    const src = readFileSync(file, "utf8");
    if (!src.includes(EM_DASH)) continue;
    filesWithEmDash += 1;
    const count = (src.match(/—/g) || []).length;
    totalEmDashes += count;
    offenders.push({ file, count });
    if (isWrite) {
      const cleaned = stripEmDashes(src);
      writeFileSync(file, cleaned, "utf8");
    }
  }

  if (isWrite) {
    console.log(
      `Rewrote ${filesWithEmDash} file(s); stripped ${totalEmDashes} em dash(es) across ${filesScanned} scanned.`,
    );
    for (const { file, count } of offenders.sort((a, b) => b.count - a.count).slice(0, 20)) {
      console.log(`  ${file}  (${count})`);
    }
    process.exit(0);
  }

  // default = check mode (CI lint)
  if (filesWithEmDash === 0) {
    console.log(`OK, no em dashes in ${filesScanned} markdown file(s).`);
    process.exit(0);
  }
  console.error(`Found ${totalEmDashes} em dash(es) in ${filesWithEmDash} file(s):`);
  for (const { file, count } of offenders.sort((a, b) => b.count - a.count)) {
    console.error(`  ${count}  ${file}`);
  }
  console.error("");
  console.error(
    "Em dashes read as AI prose. Run `node scripts/strip-em-dashes.mjs --write` to rewrite.",
  );
  process.exit(1);
}
