#!/usr/bin/env node
/**
 * Risk-register drift guard (Opus 4.8 review N-7, batch 9 P2).
 *
 * `docs/risk-register.{md,json}` is the diligence surface a buyer or auditor
 * reads to answer "what's open?". Two prior peer reviews (Codex + Opus 4.8)
 * both flagged that R-06 and R-07 were stale (status=open in the register
 * while the underlying code was clearly closed). That class of drift damages
 * trust because the register IS the trust signal.
 *
 * This guard prevents the drift class structurally. It fails the build when:
 *
 *   1. risk-register.json is structurally invalid (missing required fields,
 *      invalid status enum, etc.).
 *   2. A risk with `closed_at` or `closed_by` set is NOT marked
 *      `status: "closed"` (the closure metadata being present without the
 *      status being closed is the specific drift class that hit R-06/R-07).
 *   3. A risk with `status: "closed"` is missing the `closed_at` or
 *      `closed_by` field (closure without provenance reads as a stub).
 *   4. risk-register.md and risk-register.json disagree on whether a risk
 *      is closed (mirror check; one source of truth is enforced by content).
 *   5. The .md "Open risks" section contains a heading whose .json status is
 *      "closed" (catches the .json being updated without the .md mirror).
 *
 * Wired into `pnpm run lint`. Test coverage in
 * scripts/__tests__/check-risk-register-drift.test.mjs.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const JSON_PATH = join(ROOT, "docs/risk-register.json");
const MD_PATH = join(ROOT, "docs/risk-register.md");

const VALID_STATUSES = new Set(["open", "mitigating", "closed"]);
const VALID_PRIORITIES = new Set(["P0", "P1", "P2", "P3"]);

function loadJson() {
  if (!existsSync(JSON_PATH)) {
    throw new Error(`risk-register.json not found at ${JSON_PATH}`);
  }
  const raw = readFileSync(JSON_PATH, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`risk-register.json is not valid JSON: ${String(err)}`);
  }
  if (!Array.isArray(parsed.risks)) {
    throw new Error(`risk-register.json must have a top-level "risks" array`);
  }
  return parsed.risks;
}

/**
 * Parse the .md file and return a map of risk_id → {section: "open" | "closed", status: <body status>}.
 * `section` is determined by which top-level heading (## Open risks vs ## Recently closed) the
 * ### R-XX heading falls under. `status` is extracted from the table row in the body if present.
 */
function loadMd() {
  if (!existsSync(MD_PATH)) {
    throw new Error(`risk-register.md not found at ${MD_PATH}`);
  }
  const src = readFileSync(MD_PATH, "utf8");
  const lines = src.split("\n");
  const out = new Map();
  let currentSection = null; // "open" | "closed" | null
  let currentRisk = null;
  for (const line of lines) {
    if (/^## Open risks\b/.test(line)) {
      currentSection = "open";
      continue;
    }
    if (/^## Recently closed\b/.test(line)) {
      currentSection = "closed";
      continue;
    }
    if (/^## /.test(line)) {
      // Any other H2 closes the risk-counting region.
      currentSection = null;
      continue;
    }
    const headingMatch = /^### (R-\d+)\./.exec(line);
    if (headingMatch !== null) {
      currentRisk = headingMatch[1];
      out.set(currentRisk, { section: currentSection ?? "unknown", status: null });
      continue;
    }
    if (currentRisk !== null) {
      // Pull the status from a "| Status | **closed** ... |" row if present.
      const statusRow = /^\|\s*Status\s*\|\s*([^|]+?)\s*\|/.exec(line);
      if (statusRow !== null) {
        const txt = statusRow[1].toLowerCase();
        for (const s of VALID_STATUSES) {
          if (txt.includes(s)) {
            const rec = out.get(currentRisk);
            if (rec !== undefined && rec.status === null) rec.status = s;
            break;
          }
        }
      }
    }
  }
  return out;
}

function validate(jsonRisks, mdRisks) {
  const errors = [];

  // ----- 1. Structural validation of risk-register.json -----
  for (const r of jsonRisks) {
    if (typeof r.id !== "string" || !/^R-\d+$/.test(r.id)) {
      errors.push(`json: risk has invalid or missing id: ${JSON.stringify(r.id)}`);
      continue;
    }
    if (typeof r.title !== "string" || r.title.length === 0) {
      errors.push(`json:${r.id}: missing title`);
    }
    if (!VALID_STATUSES.has(r.status)) {
      errors.push(
        `json:${r.id}: status="${String(r.status)}" is invalid; must be one of ${[...VALID_STATUSES].join(", ")}`,
      );
    }
    if (r.priority !== undefined && !VALID_PRIORITIES.has(r.priority)) {
      errors.push(
        `json:${r.id}: priority="${String(r.priority)}" is invalid; must be one of ${[...VALID_PRIORITIES].join(", ")}`,
      );
    }
  }

  // ----- 2. closed_at / closed_by metadata implies status=closed -----
  for (const r of jsonRisks) {
    const hasClosedAt = typeof r.closed_at === "string" && r.closed_at.length > 0;
    const hasClosedBy = typeof r.closed_by === "string" && r.closed_by.length > 0;
    if ((hasClosedAt || hasClosedBy) && r.status !== "closed") {
      errors.push(
        `json:${r.id}: closed_at/closed_by is set ("${r.closed_at ?? ""}" / "${r.closed_by ?? ""}") but status="${r.status}". This is the N-1 drift class (R-06/R-07 batch 9 fix): the closure metadata being present without status=closed is exactly what diligence readers misread.`,
      );
    }
  }

  // ----- 3. status=closed REQUIRES closed_at + closed_by -----
  for (const r of jsonRisks) {
    if (r.status === "closed") {
      if (typeof r.closed_at !== "string" || r.closed_at.length === 0) {
        errors.push(
          `json:${r.id}: status=closed but closed_at is missing or empty. Closure without a date reads as a stub.`,
        );
      }
      if (typeof r.closed_by !== "string" || r.closed_by.length === 0) {
        errors.push(
          `json:${r.id}: status=closed but closed_by is missing or empty. Closure without provenance reads as a stub.`,
        );
      }
    }
  }

  // ----- 4. .json and .md must agree on every risk's open/closed disposition -----
  for (const r of jsonRisks) {
    const md = mdRisks.get(r.id);
    if (md === undefined) {
      errors.push(`mirror:${r.id}: present in risk-register.json but missing from risk-register.md`);
      continue;
    }
    const jsonIsClosed = r.status === "closed";
    const mdIsClosed = md.section === "closed" || md.status === "closed";
    if (jsonIsClosed !== mdIsClosed) {
      errors.push(
        `mirror:${r.id}: disposition disagrees. json status="${r.status}" (closed=${jsonIsClosed}) vs md section="${md.section}" status="${md.status ?? "<none>"}" (closed=${mdIsClosed})`,
      );
    }
  }
  for (const mdId of mdRisks.keys()) {
    if (!jsonRisks.some((r) => r.id === mdId)) {
      errors.push(`mirror:${mdId}: present in risk-register.md but missing from risk-register.json`);
    }
  }

  // ----- 5. md "## Open risks" section must not contain closed entries -----
  for (const [id, md] of mdRisks) {
    if (md.section === "open" && md.status === "closed") {
      errors.push(
        `md:${id}: heading is under "## Open risks" but body status reads "closed". Move it under "## Recently closed".`,
      );
    }
  }

  return errors;
}

function main() {
  let errors;
  try {
    const jsonRisks = loadJson();
    const mdRisks = loadMd();
    errors = validate(jsonRisks, mdRisks);
  } catch (err) {
    console.error("risk-register-drift guard: FAIL");
    console.error("  " + String(err));
    process.exit(2);
  }
  if (errors.length > 0) {
    console.error("risk-register-drift guard: FAIL");
    for (const e of errors) console.error("  " + e);
    console.error(
      "\nThe register is the diligence surface buyers and auditors read. Drift\n" +
        "between docs/risk-register.json, docs/risk-register.md, and the\n" +
        "closure metadata damages trust. See scripts/check-risk-register-drift.mjs\n" +
        "for the specific invariants.",
    );
    process.exit(1);
  }
  console.log("risk-register-drift guard: OK");
}

main();
