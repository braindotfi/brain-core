/**
 * Brain SDK quickstart.
 *
 * Usage:
 *   TOKEN=$(pnpm -C tools/dev-token exec tsx src/index.ts --tenant <tnt_id>)
 *   BRAIN_TOKEN=$TOKEN pnpm -C clients/sdk exec tsx examples/quickstart.ts
 *
 * Or with a commercial read-only key:
 *   BRAIN_API_KEY=brain_sk_live_... \
 *   BRAIN_BASE_URL=https://api.brain.fi/v1 \
 *   pnpm -C clients/sdk exec tsx examples/quickstart.ts
 *
 * Or against the hosted demo endpoint (sandbox and staging are the same
 * shared testnet host, see BRAIN_BASE_URLS):
 *   BRAIN_TOKEN=$(curl -s https://staging-api.brain.fi/v1/demo/token | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).token)") \
 *   BRAIN_BASE_URL=https://staging-api.brain.fi/v1 \
 *   pnpm -C clients/sdk exec tsx examples/quickstart.ts
 */

import { Brain } from "../src/index.js";

const token = process.env["BRAIN_TOKEN"];
const apiKey = process.env["BRAIN_API_KEY"];
if ((token === undefined || token.length === 0) && (apiKey === undefined || apiKey.length === 0)) {
  console.error("BRAIN_TOKEN or BRAIN_API_KEY is required");
  process.exit(1);
}
if (token !== undefined && token.length > 0 && apiKey !== undefined && apiKey.length > 0) {
  console.error("Set only one of BRAIN_TOKEN or BRAIN_API_KEY");
  process.exit(1);
}

const brain =
  token !== undefined && token.length > 0
    ? new Brain({ token, baseUrl: process.env["BRAIN_BASE_URL"] })
    : new Brain({ apiKey: apiKey!, baseUrl: process.env["BRAIN_BASE_URL"] });

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

// Wiki access is available to the JWT demo token, not to commercial API keys.
if (token !== undefined && token.length > 0) {
  try {
    const answer = await brain.ask("_", "What is our current cash position?");
    console.log("wiki answer:");
    console.log(" ", answer.answer);
    console.log("");
  } catch {
    console.log("wiki: skipped (OPENAI_API_KEY not configured)");
    console.log("");
  }
}

// ── Audit: latest anchor ───────────────────────────────────────────────────
const anchor = await brain.audit.anchor.latest();
console.log("latest anchor:");
console.log(`  batch   : ${anchor.batch_id}`);
console.log(`  root    : ${anchor.merkle_root}`);
console.log(`  tx hash : ${anchor.tx_hash ?? "(not yet anchored)"}`);
