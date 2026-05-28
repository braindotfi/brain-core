#!/usr/bin/env node
/**
 * §6 composition-root invariant — every production construction of
 * PaymentIntentService MUST thread the M2M gate loaders through the deps
 * object so checks 5.5 (agent_counterparty_attested) and 8.5
 * (micropayment_cap_within_window) enforce instead of degrading to
 * `not_applicable`.
 *
 * WHY THIS GUARD EXISTS
 *
 * The runtime §6 invariant at services/execution/src/outbox/worker.ts:130
 * refuses to dispatch a row whose `audit_before_id` is empty — i.e. it catches
 * the lint-bypass case where a rail dispatch happens without the gate running
 * at all. It does NOT catch the loader-drift case: if a loader is absent, the
 * gate runs successfully, the check records `not_applicable`, audit-before
 * fires normally, and dispatch proceeds. The row reaches the rail with a
 * perfectly valid `audit_before_id`.
 *
 * That's the gap this lint catches: a code path that constructs
 * PaymentIntentService without threading the M2M loaders silently weakens the
 * gate. The all-in-one api boot (services/api/src/main.ts) is the canonical
 * site; this script checks that every other production-eligible composition
 * root (notably services/execution/src/server.ts, which is built + pushed to
 * ACR on every main push) matches.
 *
 * REQUIRED LOADERS (must appear in the PaymentIntentService constructor arg)
 *   - attestCounterpartyAgent  →  check 5.5  →  RFC 0001 §6.3
 *   - sumAgentWindowSpend      →  check 8.5  →  RFC 0001 §6.4
 *
 * Two more loaders (`resolveEscrowState`, `metrics`) are opt-in even in
 * production (escrow is env-gated; metrics is a sink) — not required by this
 * lint.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const REQUIRED_LOADERS = ["attestCounterpartyAgent", "sumAgentWindowSpend"];
const DEFAULT_ROOTS = ["services"];
const SKIP_DIRS = new Set(["node_modules", "dist", "__snapshots__", "coverage", ".turbo"]);
const NEEDLE = "new PaymentIntentService(";

function* walkTs(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walkTs(p);
    else if (st.isFile() && p.endsWith(".ts")) yield p;
  }
}

/** Capture the balanced-parens constructor argument starting at the `(` of
 *  `new PaymentIntentService(`. Returns the inside-parens substring or null. */
function captureBalanced(src, parenIdx) {
  let depth = 1;
  let i = parenIdx + 1;
  const start = i;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    i++;
  }
  return depth === 0 ? src.slice(start, i - 1) : null;
}

/** Strip `// …` line comments so loader names mentioned inside comments don't
 *  satisfy the presence check ("commented-out loaders" must not pass lint). */
function stripLineComments(src) {
  return src
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

function isTestFile(file) {
  return (
    file.endsWith(".test.ts") ||
    file.endsWith(".spec.ts") ||
    file.includes("/__fixtures__/") ||
    file.includes("/__mocks__/")
  );
}

/**
 * Scan `rootDirs` (defaults to ["services"]) for every production
 * `new PaymentIntentService(...)` site and return any missing M2M loaders.
 * Test/spec/fixture/mock files are exempt.
 */
export function findViolations(rootDirs = DEFAULT_ROOTS) {
  const violations = [];
  const sites = [];
  const roots = Array.isArray(rootDirs) ? rootDirs : [rootDirs];
  for (const root of roots) {
    for (const file of walkTs(root)) {
      if (isTestFile(file)) continue;
      const src = readFileSync(file, "utf8");
      let idx = 0;
      while ((idx = src.indexOf(NEEDLE, idx)) !== -1) {
        const parenIdx = idx + NEEDLE.length - 1;
        const ctor = captureBalanced(src, parenIdx);
        idx = parenIdx + 1;
        if (ctor === null) continue;
        const line = src.slice(0, idx).split("\n").length;
        sites.push({ file, line });
        const code = stripLineComments(ctor);
        const missing = REQUIRED_LOADERS.filter((k) => !code.includes(k));
        if (missing.length > 0) violations.push({ file, line, missing });
      }
    }
  }
  return { violations, sites };
}

// CLI driver — guarded so the test file can import findViolations without
// triggering process.exit. Normalises both sides through fileURLToPath so
// paths with spaces (e.g. "/Users/x/Brain Code/...") match correctly.
const isCli = fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) {
  const { violations, sites } = findViolations();
  if (violations.length > 0) {
    console.error("§6 composition-root invariant violated — drift between production roots:\n");
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line} — missing loaders: ${v.missing.join(", ")}`);
    }
    console.error(
      "\nEvery production PaymentIntentService construction must thread the M2M",
    );
    console.error(
      "gate loaders (attestCounterpartyAgent, sumAgentWindowSpend) so §6 checks",
    );
    console.error("5.5 and 8.5 enforce instead of degrading to `not_applicable`.\n");
    console.error("Canonical site: services/api/src/main.ts");
    console.error(
      "See scripts/check-payment-intent-loaders.mjs for the rationale (lint-vs-runtime gap).",
    );
    process.exit(1);
  }
  console.log(
    `OK — checked ${sites.length} PaymentIntentService construction site(s); all required loaders threaded.`,
  );
  for (const s of sites) console.log(`  ${s.file}:${s.line}`);
}
