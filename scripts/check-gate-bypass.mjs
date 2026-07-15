#!/usr/bin/env node
/**
 * §6 gate-bypass guard.
 *
 * No money-movement may bypass the deterministic pre-execution gate
 * (Brain_Engineering_Standards.md §6). With the H-04 durable execution outbox
 * the money-movement is split across exactly two files, so the guard is
 * SIGNAL-SPECIFIC (not a single per-file allowlist):
 *
 *   (a) Rail dispatch — the act of moving money — is allowed ONLY in the outbox
 *       worker (services/execution/src/outbox/worker.ts). The worker dispatches
 *       ONLY rows drained from execution_outbox, and a row lands there only
 *       AFTER PaymentIntentService.execute ran the full §6 gate and emitted
 *       audit-before. So "no money moves without the gate" still holds.
 *
 *   (b) The API rail client signing sinks (`writeContract`) are allowed ONLY in
 *       the low-level rail client modules under services/api/src/rails. Those
 *       builders are imported only by the composition root and handed to
 *       execution rail classes, so routes cannot sign money movement directly.
 *
 *   (c) The terminal `executed` transition is allowed ONLY in
 *       services/execution/src/payment-intents/PaymentIntentService.ts
 *       (completeExecution). The worker never settles a PaymentIntent itself —
 *       it calls back into PaymentIntentService.
 *
 * Crucially this now FAILS CI if PaymentIntentService dispatches a rail directly
 * (the old synchronous path is gone) or if any other file flips an intent to
 * `executed`. It also catches the facade form `LedgerPaymentIntents.transition(
 * …, "executed")`, which the previous regex missed.
 *
 * Run: pnpm run check-gate-bypass
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SCAN_DIRS = ["services/execution/src", "services/api/src/rails"];
const API_SCAN_DIR = "services/api/src";

// Rail dispatch (moving money) — only the outbox worker may do this.
const RAIL_DISPATCH = /\.dispatch\s*\(/;
const RAIL_DISPATCH_ALLOWED = ["services/execution/src/outbox/worker.ts"];

const CHAIN_WRITE = /\.writeContract\s*\(/;
const CHAIN_WRITE_ALLOWED = [
  "services/api/src/rails/onchainExecutor.ts",
  "services/api/src/rails/x402Client.ts",
];

const MONEY_CLIENT_IMPORT =
  /from\s+["'](?:\.\/|\.\.\/)*rails\/(?:onchainExecutor|x402Client)\.js["']/;
const MONEY_CLIENT_IMPORT_ALLOWED = ["services/api/src/main.ts"];

// The terminal `executed` transition — only the gated executor may do this.
// Matches both the direct repo helpers (transitionPaymentIntent/Proposal/
// Execution(..., "executed")) and the facade form (.transition(..., "executed")).
const EXECUTED_TRANSITION =
  /transition(?:PaymentIntent|Proposal|Execution)?\s*\([^;]*["']executed["']/;
const EXECUTED_TRANSITION_ALLOWED = [
  "services/execution/src/payment-intents/PaymentIntentService.ts",
];

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
for (const dir of SCAN_DIRS) {
  for (const file of walk(dir)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (RAIL_DISPATCH.test(line) && !RAIL_DISPATCH_ALLOWED.includes(file)) {
        violations.push(`${file}:${i + 1}: rail .dispatch() outside the outbox worker`);
      }
      if (CHAIN_WRITE.test(line) && !CHAIN_WRITE_ALLOWED.includes(file)) {
        violations.push(`${file}:${i + 1}: writeContract() outside sanctioned API rail clients`);
      }
      if (EXECUTED_TRANSITION.test(line) && !EXECUTED_TRANSITION_ALLOWED.includes(file)) {
        violations.push(`${file}:${i + 1}: transition to 'executed' outside the §6-gated executor`);
      }
    });
  }
}

for (const file of walk(API_SCAN_DIR)) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (MONEY_CLIENT_IMPORT.test(line) && !MONEY_CLIENT_IMPORT_ALLOWED.includes(file)) {
      violations.push(`${file}:${i + 1}: API rail signing client imported outside main.ts`);
    }
  });
}

if (violations.length > 0) {
  console.error("§6 gate bypass detected — money movement must go through the gated path:");
  for (const v of violations) console.error(`  ${v}`);
  console.error(
    "\nRail dispatch is allowed only in the outbox worker; the 'executed' transition only in" +
      "\nPaymentIntentService. API writeContract sinks are allowed only in the rail clients." +
      "\nIf you are adding a legitimate new gated path, update the" +
      "\nsignal allowlists in scripts/check-gate-bypass.mjs with a comment explaining the invariant.",
  );
  process.exit(1);
}

console.log("§6 gate-bypass guard: OK");
