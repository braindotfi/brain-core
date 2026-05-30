#!/usr/bin/env node
/**
 * Print the readiness trend across every snapshot in `docs/readiness-history/`.
 *
 *   pnpm run readiness-trend
 *
 * Output: one row per snapshot, ordered by filename (which is the tag).
 * Columns: tag, overall_status, red_count, yellow_count, green_count,
 * open_p0_risks, open_p1_risks. The last column shows the delta in open_p0
 * relative to the previous snapshot so a reader sees whether the trajectory
 * is improving, stable, or worsening.
 *
 * Use cases:
 *   - investor-update prep ("here's the open-P0 trajectory")
 *   - release-readiness review ("did this release close any risks?")
 *   - audit-trail of when the codebase first cleared a particular blocker
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const HISTORY_DIR = join(ROOT, "docs/readiness-history");

function loadSnapshots() {
  if (!existsSync(HISTORY_DIR)) return [];
  return readdirSync(HISTORY_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort() // tag order; users name tags monotonically (v0.3.0-rc.1 etc.)
    .map((f) => {
      const path = join(HISTORY_DIR, f);
      const tag = f.replace(/\.json$/, "");
      const data = JSON.parse(readFileSync(path, "utf8"));
      return { tag, path, data };
    });
}

function summarize(aggregator) {
  const allRows = [
    ...(aggregator.sections.rails ?? []),
    ...(aggregator.sections.fences ?? []),
    ...(aggregator.sections.ci_guards ?? []),
    ...(aggregator.sections.deferred ?? []),
    ...(aggregator.sections.risks ?? []),
  ];
  const red = allRows.filter((r) => r.status === "red").length;
  const yellow = allRows.filter((r) => r.status === "yellow").length;
  const green = allRows.filter((r) => r.status === "green").length;
  const risks = aggregator.sections.risks ?? [];
  const openP0 = risks.filter((r) => /\[P0 open\]/.test(r.note ?? "")).length;
  const openP1 = risks.filter((r) => /\[P1 open\]/.test(r.note ?? "")).length;
  return {
    overall: aggregator.overall_status,
    red,
    yellow,
    green,
    openP0,
    openP1,
  };
}

function delta(curr, prev) {
  if (prev === undefined) return "—";
  const d = curr - prev;
  if (d > 0) return `+${String(d)}`;
  if (d < 0) return String(d);
  return "0";
}

function main() {
  const snapshots = loadSnapshots();
  if (snapshots.length === 0) {
    console.log(
      "no snapshots in docs/readiness-history/ yet. Run `pnpm run readiness-snapshot <tag>` to capture the first.",
    );
    return;
  }

  console.log("Brain readiness trend");
  console.log("");
  console.log(
    "  tag                            overall   red yellow green  P0 P1   ΔP0",
  );
  console.log(
    "  ─────────────────────────────  ────────  ─── ────── ─────  ── ──   ───",
  );

  let prevOpenP0;
  for (const s of snapshots) {
    const sum = summarize(s.data.aggregator);
    const tag = s.tag.padEnd(29).slice(0, 29);
    const overall = sum.overall.padEnd(8);
    const red = String(sum.red).padStart(3);
    const yellow = String(sum.yellow).padStart(6);
    const green = String(sum.green).padStart(5);
    const p0 = String(sum.openP0).padStart(2);
    const p1 = String(sum.openP1).padStart(2);
    const d = delta(sum.openP0, prevOpenP0).padStart(5);
    console.log(`  ${tag}  ${overall}  ${red} ${yellow} ${green}  ${p0} ${p1}   ${d}`);
    prevOpenP0 = sum.openP0;
  }

  console.log("");
  if (snapshots.length === 1) {
    console.log("Only one snapshot; capture another at the next release for trend lines.");
  }
}

main();
