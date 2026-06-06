#!/usr/bin/env node
/**
 * CI guard: integrity of contracts/audit-status.json (R-01 automation).
 *
 * audit-status.json is the committed, reviewable source of truth for the
 * external smart-contract audit. The escrow boot fence
 * (composition/escrow-audit-gate.ts) refuses to start the api against Base
 * mainnet unless this file authorizes it, so an operator can no longer flip a
 * bare env var to bypass a pending audit. This guard makes the file itself
 * un-handwave-able: a status of "approved" REQUIRES real evidence, so a bogus
 * or premature "approved" cannot land in review.
 *
 * The validation RULES live in scripts/lib/audit-status.mjs (the canonical
 * `.mjs` port), which the runtime escrow fence mirrors in TypeScript
 * (shared/src/audit-status.ts). Both ports are pinned to identical behaviour by
 * a shared parity corpus (scripts/lib/audit-status.fixtures.json). This guard
 * owns only the file IO + reporting; it does not re-implement the rules.
 *
 * Checks (all delegated to the canonical validator):
 *   - structural integrity: required keys, valid status, finding-count shape;
 *   - status === "approved" ALSO requires the full evidence set (auditor,
 *     40-hex audited commit, a report reference, zero critical/high findings).
 *
 * Exit 0 + a summary line on success; exit 1 + the reasons on any violation.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { checkIntegrity, evaluateApproval } from "./lib/audit-status.mjs";

const FILE = join(process.cwd(), "contracts/audit-status.json");

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

  // Structural integrity always applies. When the record claims "approved",
  // the full evidence set must also hold; evaluateApproval re-reports the
  // integrity reasons, so dedupe before failing.
  const reasons = [...checkIntegrity(doc).reasons];
  if (doc.status === "approved") {
    for (const r of evaluateApproval(doc).reasons) {
      if (!reasons.includes(r)) reasons.push(r);
    }
  }

  if (reasons.length > 0) fail(reasons);

  console.log(`audit-status guard: OK (contract=${doc.contract}, status=${doc.status})`);
}

main();
