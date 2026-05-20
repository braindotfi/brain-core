/**
 * Brain SDK quickstart.
 *
 * Usage:
 *   TOKEN=$(pnpm -C tools/dev-token exec tsx src/index.ts --tenant <tnt_id>)
 *   BRAIN_TOKEN=$TOKEN pnpm -C clients/sdk exec tsx examples/quickstart.ts
 *
 * Or against the hosted demo endpoint:
 *   BRAIN_TOKEN=$(curl -s https://api.brain.dev/v1/demo/token | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).token)") \
 *   BRAIN_BASE_URL=https://api.brain.dev/v1 \
 *   pnpm -C clients/sdk exec tsx examples/quickstart.ts
 */

import { Brain } from "../src/index.js";

const token = process.env["BRAIN_TOKEN"];
if (!token) {
  console.error("BRAIN_TOKEN is required");
  process.exit(1);
}

const brain = new Brain({
  token,
  baseUrl: process.env["BRAIN_BASE_URL"],
});

console.log("Brain SDK quickstart");
console.log(`  base URL : ${brain.baseUrl}`);
console.log(`  token    : ${brain.getMaskedToken()}`);
console.log("");

// ── Ledger: list accounts ──────────────────────────────────────────────────
const { accounts } = await brain.accounts.list({ status: "active" });
console.log(`accounts (${accounts?.length ?? 0}):`);
for (const acct of accounts ?? []) {
  console.log(`  ${acct.id}  ${acct.account_type}  ${acct.name ?? "(unnamed)"}`);
}
console.log("");

// ── Wiki: ask a question ───────────────────────────────────────────────────
try {
  const answer = await brain.ask("_", "What is our current cash position?");
  console.log("wiki answer:");
  console.log(" ", answer.answer);
  console.log("");
} catch {
  console.log("wiki: skipped (OPENAI_API_KEY not configured)");
  console.log("");
}

// ── Audit: latest anchor ───────────────────────────────────────────────────
const anchor = await brain.audit.anchor.latest();
console.log("latest anchor:");
console.log(`  batch   : ${anchor.batch_id}`);
console.log(`  root    : ${anchor.merkle_root}`);
console.log(`  tx hash : ${anchor.tx_hash ?? "(not yet anchored)"}`);
