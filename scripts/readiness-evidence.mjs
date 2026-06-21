#!/usr/bin/env node
/**
 * Diligence-ready readiness evidence report.
 *
 * Wraps production-readiness --json so release managers can hand one artifact
 * to diligence reviewers without losing the machine-readable evidence_state
 * fields that gate staging/mainnet promotion.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const RAW_ARGS = process.argv.slice(2);

function parseProfileArg() {
  const eq = RAW_ARGS.find((a) => a.startsWith("--profile="));
  if (eq !== undefined) return eq.slice("--profile=".length);
  const i = RAW_ARGS.indexOf("--profile");
  if (i >= 0 && RAW_ARGS[i + 1] !== undefined) return RAW_ARGS[i + 1];
  return "staging";
}

const profile = parseProfileArg();
const jsonMode = RAW_ARGS.includes("--json");

function runReadiness() {
  try {
    return execFileSync(
      "node",
      ["scripts/production-readiness.mjs", "--json", `--profile=${profile}`],
      { cwd: ROOT, env: process.env, encoding: "utf8" },
    );
  } catch (err) {
    const stdout = err.stdout?.toString() ?? "";
    if (stdout.trim().startsWith("{")) return stdout;
    throw err;
  }
}

function auditStatus() {
  try {
    return JSON.parse(readFileSync(join(ROOT, "contracts/audit-status.json"), "utf8"));
  } catch {
    return { status: "missing" };
  }
}

const readiness = JSON.parse(runReadiness());
const audit = auditStatus();
const sections = readiness.sections ?? {};
const allRows = Object.entries(sections).flatMap(([section, rows]) =>
  rows.map((row) => ({ section, ...row })),
);

if (jsonMode) {
  console.log(
    JSON.stringify(
      {
        profile,
        generated_at: new Date().toISOString(),
        readiness,
        audit_status: audit,
      },
      null,
      2,
    ),
  );
  process.exit(readiness.profiles?.[profile]?.status === "red" ? 1 : 0);
}

function table(rows) {
  const lines = ["| Area | Status | Evidence | Tier | Note |", "| --- | --- | --- | --- | --- |"];
  for (const row of rows) {
    lines.push(
      `| ${row.name} | ${row.status} | ${row.evidence_state ?? "missing"} | ${row.tier} | ${String(row.note ?? "").replace(/\|/g, "\\|")} |`,
    );
  }
  return lines.join("\n");
}

function findRow(name) {
  return allRows.find((r) => r.name === name) ?? null;
}

const profileResult = readiness.profiles?.[profile] ?? { status: "missing", blockers: {} };
const weakEvidence = allRows.filter((r) => r.evidence_state !== "exercised");
const knownLimitations = [
  ...allRows
    .filter((r) => r.status !== "green")
    .map((r) => `${r.name}: ${r.status} (${r.note})`),
  ...weakEvidence.map((r) => `${r.name}: evidence_state=${r.evidence_state}`),
  "Worker health is not live-polled by this pre-deploy command; pair this report with runtime worker lease and queue-age dashboards.",
  "Projection health is not live-polled by this pre-deploy command; pair this report with canonical/ledger projection lag dashboards.",
];

const lines = [];
lines.push(`# Brain Readiness Evidence Report`);
lines.push("");
lines.push(`Generated: ${new Date().toISOString()}`);
lines.push(`Profile: \`${profile}\``);
lines.push(`Profile status: \`${profileResult.status}\``);
lines.push(`Node env: \`${readiness.node_env}\``);
lines.push("");
lines.push("## Promotion Blockers");
lines.push("");
const red = profileResult.blockers?.red ?? [];
const yellow = profileResult.blockers?.yellow ?? [];
if (red.length === 0 && yellow.length === 0) {
  lines.push("No blockers for the selected profile.");
} else {
  for (const b of red) lines.push(`- RED: ${b}`);
  for (const b of yellow) lines.push(`- YELLOW: ${b}`);
}
lines.push("");
lines.push("## Evidence Rows");
lines.push("");
lines.push(table(allRows));
lines.push("");
lines.push("## Focus Areas");
lines.push("");
for (const name of [
  "On-chain executor testnet E2E",
  "External smart-contract audit (BrainEscrow)",
  "Escrow audit (mainnet)",
  "Live rails (production)",
  "DB isolation",
  "check-connector-descriptors",
  "check-partner-connector-isolation",
]) {
  const row = findRow(name);
  if (row !== null) {
    lines.push(`- ${name}: ${row.status}, evidence=${row.evidence_state}, ${row.note}`);
  }
}
lines.push(`- Audit status file: status=${audit.status}, auditor=${audit.auditor ?? "none"}`);
lines.push("- Worker health: requires runtime dashboard evidence for leases, queue age, and crash loops.");
lines.push("- Projection health: requires runtime dashboard evidence for canonical and ledger projection lag.");
lines.push("");
lines.push("## Known Limitations");
lines.push("");
for (const item of [...new Set(knownLimitations)]) lines.push(`- ${item}`);

console.log(lines.join("\n"));
process.exit(profileResult.status === "red" ? 1 : 0);
