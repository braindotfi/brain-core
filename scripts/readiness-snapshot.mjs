#!/usr/bin/env node
/**
 * Capture a per-tag snapshot of `production-readiness --json` for the
 * git-native trend tracking at `docs/readiness-history/`.
 *
 * Usage:
 *   pnpm run readiness-snapshot <tag>
 *
 * Where `<tag>` is the release tag or any human-meaningful identifier
 * (release-2026-05-30, v0.3.0-rc.1, etc.). The file
 * `docs/readiness-history/<tag>.json` is written with the aggregator
 * output plus the captured tag and the time of capture.
 *
 * The aggregator may exit 1 (open P0 risk) by design; the snapshot
 * always captures the JSON regardless. This script never fails — it
 * either writes the snapshot or refuses to overwrite an existing one.
 *
 * In CI, fired on release tag push:
 *
 *   - run: |
 *       pnpm run readiness-snapshot ${{ github.ref_name }}
 *       git add docs/readiness-history/
 *       git -c user.name=brain-ci -c user.email=ci@brain.fi commit -m "..."
 */

import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const HISTORY_DIR = join(ROOT, "docs/readiness-history");
const AGGREGATOR = join(ROOT, "scripts/production-readiness.mjs");

function main() {
  const tag = process.argv[2];
  if (tag === undefined || tag.length === 0) {
    console.error("usage: readiness-snapshot <tag>");
    console.error('example: readiness-snapshot "v0.3.0-rc.1"');
    process.exit(2);
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(tag)) {
    console.error(`refusing to use tag "${tag}": must be [a-zA-Z0-9._-]+`);
    process.exit(2);
  }

  const outPath = join(HISTORY_DIR, `${tag}.json`);
  if (existsSync(outPath)) {
    console.error(`refusing to overwrite existing snapshot: ${outPath}`);
    console.error("rename the tag or delete the file first.");
    process.exit(2);
  }

  // Run the aggregator. Open P0 risks make it exit 1 by design; capture
  // stdout regardless of exit code.
  let aggregatorJson = "";
  try {
    aggregatorJson = execFileSync("node", [AGGREGATOR, "--json"], {
      encoding: "utf8",
    });
  } catch (err) {
    aggregatorJson = err.stdout?.toString() ?? "";
  }

  if (aggregatorJson.length === 0) {
    console.error("aggregator produced no JSON output; refusing to write empty snapshot.");
    process.exit(2);
  }

  let parsed;
  try {
    parsed = JSON.parse(aggregatorJson);
  } catch {
    console.error("aggregator output was not valid JSON; refusing to snapshot.");
    process.exit(2);
  }

  // Date.now() is intentionally NOT used so the snapshot is reproducible:
  // CI passes the timestamp as part of the tag instead, or we leave it null
  // and rely on the git commit time as the truth. Snapshots are immutable
  // once committed; the tag IS the time.
  const snapshot = {
    captured_at_tag: tag,
    aggregator: parsed,
  };

  mkdirSync(HISTORY_DIR, { recursive: true });
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2) + "\n");
  console.log(`readiness-snapshot: wrote ${outPath}`);
}

main();
