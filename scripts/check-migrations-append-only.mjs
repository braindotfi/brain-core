#!/usr/bin/env node
/**
 * CI guard: migration files are append-only.
 *
 * Commit 307ed8f edited comments inside the already-applied migration
 * services/execution/migrations/0018_agents_contribution_counter.sql. The
 * migration runner (tools/migrate) hashes whole files and fails closed on any
 * drift from what was recorded as applied, so a comment-only edit to a
 * shipped migration broke the main deploy workflow even though the SQL
 * semantics never changed. Once a migration file has been merged to main, it
 * must never be edited or deleted again, fix forward with a new migration
 * instead (the rename semantics that motivated the 307ed8f edit now live in
 * 0026_contribution_hold_rename.sql).
 *
 * This guard fails the diff between HEAD and its base commit whenever an
 * EXISTING <dir>/migrations/<file>.sql file was modified, deleted, or renamed
 * away. Newly added migration files are fine.
 *
 * Base resolution: `git merge-base origin/main HEAD`, matching how the
 * gitleaks job in .github/workflows/pr.yml diffs against origin/main (that
 * job's checkout uses fetch-depth: 0 for the same reason; the typescript job,
 * which runs `pnpm run lint` and therefore this guard, now does too). If HEAD
 * already equals that merge-base (running on main itself, or no origin/main
 * ref is reachable), fall back to comparing HEAD~1..HEAD so a bad commit
 * landing straight on main is still caught.
 *
 * Run: pnpm run check-migrations-append-only
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MIGRATION_FILE_RE = /(^|\/)migrations\/[^/]+\.sql$/;

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function fail(reasons) {
  console.error("migrations-append-only guard: FAIL");
  for (const r of reasons) console.error(`  - ${r}`);
  console.error(
    "\nMigration files are append-only once merged: an applied migration is\n" +
      "hashed whole-file by tools/migrate and fails closed on drift, so editing\n" +
      "or deleting one breaks every environment that already applied it. Add a\n" +
      "new migration to change behaviour instead of editing an existing one.",
  );
  process.exit(1);
}

// Parse `git diff --name-status <base> HEAD` output into { status, path }
// entries, one per changed file. Renames/copies come through as three-column
// lines ("R100\told\tnew"); we keep the OLD path (cols[1]), since that is the
// pre-existing migration file being touched.
export function parseNameStatus(raw) {
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const cols = line.split("\t");
      return { status: cols[0][0], path: cols[1] };
    });
}

// Given parsed diff entries, return one violation string per existing
// migration file that was modified, deleted, or renamed away. Added (A)
// migration files are fine; copies (C) leave the original untouched.
export function findViolations(entries) {
  const violations = [];
  for (const { status, path } of entries) {
    if (!MIGRATION_FILE_RE.test(path)) continue;
    if (status === "M") violations.push(`${path}: modified after being merged`);
    if (status === "D") violations.push(`${path}: deleted after being merged`);
    if (status === "R") violations.push(`${path}: renamed after being merged`);
  }
  return violations;
}

// Resolve the base commit to diff against. Returns null when there is
// nothing to compare (HEAD has no parent).
function resolveBase() {
  const head = git(["rev-parse", "HEAD"]);

  let base;
  try {
    base = git(["merge-base", "origin/main", "HEAD"]);
  } catch {
    console.log(
      "migrations-append-only guard: no origin/main ref reachable (shallow checkout?), " +
        "falling back to HEAD~1..HEAD.",
    );
    try {
      return git(["rev-parse", "HEAD~1"]);
    } catch {
      console.log(
        "migrations-append-only guard: HEAD has no parent, nothing to compare, skipping.",
      );
      return null;
    }
  }

  if (base === head) {
    // HEAD is already origin/main (running on main post-merge, or this branch
    // has no divergence left) so the usual base..HEAD diff would be empty.
    // Compare against the immediate parent instead.
    console.log(
      "migrations-append-only guard: HEAD is at origin/main, comparing HEAD~1..HEAD instead.",
    );
    try {
      return git(["rev-parse", "HEAD~1"]);
    } catch {
      console.log(
        "migrations-append-only guard: HEAD has no parent, nothing to compare, skipping.",
      );
      return null;
    }
  }

  return base;
}

function main() {
  const base = resolveBase();
  if (base === null) {
    console.log("migrations-append-only guard: OK (nothing to compare)");
    return;
  }

  // Diff against the working tree (no second ref), not HEAD, so an
  // uncommitted-but-staged-or-unstaged edit to a migration is caught locally
  // too. In CI the checkout is clean, so this is identical to diffing
  // base..HEAD there.
  const raw = git(["diff", "--name-status", base]);
  const violations = findViolations(parseNameStatus(raw));

  if (violations.length > 0) fail(violations);

  console.log(`migrations-append-only guard: OK (compared ${base.slice(0, 12)}..working tree)`);
}

// CLI driver, guarded so the unit test can import the pure helpers without
// triggering the git calls or process.exit.
const isCli = fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) main();
