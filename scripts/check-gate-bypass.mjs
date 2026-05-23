#!/usr/bin/env node
/**
 * §6 gate-bypass guard.
 *
 * No money-movement may bypass the deterministic pre-execution gate
 * (Brain_Engineering_Standards.md §6). The gated executor is
 * services/execution/src/payment-intents/PaymentIntentService.ts — it is the
 * single place allowed to (a) dispatch a payment rail and (b) transition a
 * PaymentIntent/Proposal to the terminal `executed` state.
 *
 * This guard fails CI if either money-movement signal appears anywhere else in
 * the execution service, which is how the legacy POST /execution/execute
 * bypass slipped in originally.
 *
 * Run: pnpm run check-gate-bypass
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SCAN_DIR = "services/execution/src";
const ALLOWLIST = ["services/execution/src/payment-intents/PaymentIntentService.ts"];

// Rail dispatch (the act of moving money) and the terminal executed transition.
const RAIL_DISPATCH = /\.dispatch\s*\(/;
const EXECUTED_TRANSITION = /transition(?:PaymentIntent|Proposal|Execution)\s*\([^;]*["']executed["']/;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".ts") && !full.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const violations = [];
for (const file of walk(SCAN_DIR)) {
  if (ALLOWLIST.includes(file)) continue;
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (RAIL_DISPATCH.test(line)) {
      violations.push(`${file}:${i + 1}: rail .dispatch() outside the §6-gated executor`);
    }
    if (EXECUTED_TRANSITION.test(line)) {
      violations.push(`${file}:${i + 1}: transition to 'executed' outside the §6-gated executor`);
    }
  });
}

if (violations.length > 0) {
  console.error("§6 gate bypass detected — money movement must go through PaymentIntentService:");
  for (const v of violations) console.error(`  ${v}`);
  console.error(
    "\nIf this is a legitimate new gated executor, add it to ALLOWLIST in scripts/check-gate-bypass.mjs.",
  );
  process.exit(1);
}

console.log("§6 gate-bypass guard: OK");
