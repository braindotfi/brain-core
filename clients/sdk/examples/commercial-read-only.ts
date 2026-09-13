/**
 * Read-only commercial API key smoke test.
 *
 * Usage:
 *   BRAIN_API_KEY=brain_sk_live_... \
 *   BRAIN_TENANT_ID=tnt_... \
 *   pnpm -C clients/sdk exec tsx examples/commercial-read-only.ts
 *
 * Set BRAIN_BASE_URL to target staging or a local deployment. The default is
 * https://api.brain.fi/v1.
 */

import { pathToFileURL } from "node:url";
import { Brain, BrainAPIError } from "../src/index.js";

export interface CommercialReadSmokeSummary {
  readonly accounts: number;
  readonly transactions: number;
  readonly auditEvents: number;
  readonly governanceAgents: number;
}

export async function runCommercialReadOnlySmoke(
  env: Readonly<Record<string, string | undefined>> = process.env,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<CommercialReadSmokeSummary> {
  const apiKey = requiredEnv(env, "BRAIN_API_KEY");
  const tenantId = requiredEnv(env, "BRAIN_TENANT_ID");
  if (!apiKey.startsWith("brain_sk_test_") && !apiKey.startsWith("brain_sk_live_")) {
    throw new Error("BRAIN_API_KEY must be a brain_sk_test_* or brain_sk_live_* key");
  }
  if (!tenantId.startsWith("tnt_")) {
    throw new Error("BRAIN_TENANT_ID must be a Brain tenant id");
  }

  const brain = new Brain({
    apiKey,
    baseUrl: env["BRAIN_BASE_URL"] ?? "https://api.brain.fi/v1",
    fetch: fetchImpl,
  });

  const [accounts, transactions, audit] = await Promise.all([
    brain.accounts.list({ limit: 10 }),
    brain.transactions.list({ limit: 10 }),
    brain.audit.list({ limit: 10 }),
  ]);
  const governance = await brain.http.GET("/governance/agents", {
    params: { query: { tenant_id: tenantId, limit: 10 } },
  });
  if (!governance.response.ok || governance.error !== undefined || governance.data === undefined) {
    throw new BrainAPIError(governance.response.status, governance.error);
  }

  return {
    accounts: accounts.accounts.length,
    transactions: transactions.transactions.length,
    auditEvents: audit.events.length,
    governanceAgents: governance.data.agents.length,
  };
}

function requiredEnv(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const summary = await runCommercialReadOnlySmoke();
  console.log("Commercial read-only API key smoke test passed");
  console.log(`accounts=${summary.accounts}`);
  console.log(`transactions=${summary.transactions}`);
  console.log(`audit_events=${summary.auditEvents}`);
  console.log(`governance_agents=${summary.governanceAgents}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Commercial read-only API key smoke test failed: ${message}`);
    process.exitCode = 1;
  });
}
