/**
 * Read-only commercial API-key smoke test.
 *
 * Usage:
 *   BRAIN_API_KEY=brain_sk_live_... \
 *   BRAIN_BASE_URL=https://api.brain.fi/v1 \
 *   pnpm -C clients/sdk exec tsx examples/commercial-key-smoke.ts
 *
 * Commercial API keys are limited to tenant-scoped ledger, audit, and
 * governance reads. This example intentionally does not call Wiki, payment,
 * proposal, approval, execution, policy, or administration routes.
 */

import { pathToFileURL } from "node:url";
import { Brain } from "../src/index.js";

export interface CommercialKeySmokeResult {
  accounts: number;
  transactions: number;
  balances: number;
  auditAnchorMode: string;
}

export async function runCommercialKeySmoke(brain: Brain): Promise<CommercialKeySmokeResult> {
  const { accounts } = await brain.accounts.list({ status: "active" });
  const { transactions } = await brain.transactions.list({ limit: 50 });
  const balances = await brain.balances.list();
  const anchor = await brain.audit.anchor.latest();

  return {
    accounts: accounts.length,
    transactions: transactions.length,
    balances: balances.length,
    auditAnchorMode: anchor.anchoringMode,
  };
}

async function main(): Promise<void> {
  const apiKey = process.env["BRAIN_API_KEY"]?.trim();
  if (!apiKey) {
    throw new Error("BRAIN_API_KEY is required");
  }
  if (!apiKey.startsWith("brain_sk_")) {
    throw new Error("BRAIN_API_KEY must be a commercial brain_sk_* key");
  }

  const brain = new Brain({
    apiKey,
    baseUrl: process.env["BRAIN_BASE_URL"],
  });
  const result = await runCommercialKeySmoke(brain);

  console.log("Brain commercial API-key smoke test");
  console.log(`  base URL   : ${brain.baseUrl}`);
  console.log(`  api key    : ${brain.getMaskedApiKey()}`);
  console.log(`  accounts   : ${result.accounts}`);
  console.log(`  transactions: ${result.transactions}`);
  console.log(`  balances   : ${result.balances}`);
  console.log(`  audit mode : ${result.auditAnchorMode}`);
}

const isDirectExecution =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
