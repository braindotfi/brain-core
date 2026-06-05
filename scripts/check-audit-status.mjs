#!/usr/bin/env node
/**
 * CI guard: integrity of contracts/audit-status.json (R-01 automation).
 *
 * audit-status.json is the committed, reviewable source of truth for the
 * external smart-contract audit. The escrow boot fence
 * (composition/escrow-audit-gate.ts) refuses to start the api against Base
 * mainnet unless this file's status is "approved", so an operator can no longer
 * flip a bare env var to bypass a pending audit. This guard makes the file
 * itself un-handwave-able: a status of "approved" REQUIRES real evidence, so a
 * bogus or premature "approved" cannot land in review.
 *
 * Rules:
 *   - the file exists, parses, and carries every required key;
 *   - status is one of pending | in_progress | approved;
 *   - unresolved_findings counts, when present, are non-negative integers;
 *   - status === "approved" additionally REQUIRES:
 *       - auditor: a non-empty string;
 *       - audited_commit: a 40-hex git SHA;
 *       - report_url OR report_sha256: a non-empty reference to the report;
 *       - unresolved_findings.critical === 0 AND .high === 0
 *         (you cannot ship "approved" with open critical/high findings).
 *
 * Exit 0 + a summary line on success; exit 1 + the reasons on any violation.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const FILE = join(process.cwd(), "contracts/audit-status.json");
const VALID_STATUS = new Set(["pending", "in_progress", "approved"]);
const REQUIRED_KEYS = [
  "contract",
  "scope_doc",
  "status",
  "auditor",
  "audited_commit",
  "report_url",
  "report_sha256",
  "unresolved_findings",
];

function fail(reasons) {
  console.error("audit-status guard: FAIL");
  for (const r of reasons) console.error(`  - ${r}`);
  console.error(
    "\ncontracts/audit-status.json is the committed source of truth for the\n" +
      "external contract audit (R-01). Marking it 'approved' requires the\n" +
      "auditor, the audited 40-hex commit, a report reference, and zero\n" +
      "unresolved critical/high findings. Update it ONLY from the final report.",
  );
  process.exit(1);
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function isNonNegInt(v) {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

function main() {
  let raw;
  try {
    raw = readFileSync(FILE, "utf8");
  } catch {
    fail(["contracts/audit-status.json is missing (it must be committed)"]);
    return;
  }

  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    fail([`contracts/audit-status.json is not valid JSON: ${err.message}`]);
    return;
  }

  const reasons = [];

  for (const k of REQUIRED_KEYS) {
    if (!(k in doc)) reasons.push(`missing required key: ${k}`);
  }

  if (!VALID_STATUS.has(doc.status)) {
    reasons.push(
      `status must be one of ${[...VALID_STATUS].join(" | ")}, got ${JSON.stringify(doc.status)}`,
    );
  }

  const uf = doc.unresolved_findings;
  if (typeof uf !== "object" || uf === null) {
    reasons.push("unresolved_findings must be an object with critical/high/medium/low");
  } else {
    for (const sev of ["critical", "high", "medium", "low"]) {
      const v = uf[sev];
      if (v !== null && !isNonNegInt(v)) {
        reasons.push(`unresolved_findings.${sev} must be null or a non-negative integer`);
      }
    }
  }

  if (doc.status === "approved") {
    if (!isNonEmptyString(doc.auditor)) {
      reasons.push("status 'approved' requires a non-empty auditor");
    }
    if (typeof doc.audited_commit !== "string" || !/^[0-9a-f]{40}$/.test(doc.audited_commit)) {
      reasons.push("status 'approved' requires audited_commit to be a 40-hex git SHA");
    }
    if (!isNonEmptyString(doc.report_url) && !isNonEmptyString(doc.report_sha256)) {
      reasons.push("status 'approved' requires a report_url or a report_sha256");
    }
    if (typeof uf === "object" && uf !== null) {
      if (uf.critical !== 0)
        reasons.push("status 'approved' requires unresolved_findings.critical === 0");
      if (uf.high !== 0) reasons.push("status 'approved' requires unresolved_findings.high === 0");
    }
  }

  if (reasons.length > 0) fail(reasons);

  console.log(`audit-status guard: OK (contract=${doc.contract}, status=${doc.status})`);
}

main();
