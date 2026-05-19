/**
 * Plaid Sandbox → Brain raw ingest.
 *
 * Usage:
 *   PLAID_CLIENT_ID=... PLAID_SECRET=... BRAIN_TOKEN=... pnpm run plaid:sandbox
 *
 * Optional:
 *   PLAID_ENV=sandbox (default)
 *   BRAIN_API_URL=http://localhost:3000 (default)
 *   PLAID_INSTITUTION_ID=ins_109508 (Chase sandbox, default)
 *
 * Steps:
 *   1. sandboxPublicTokenCreate → itemPublicTokenExchange (sandbox item)
 *   2. transactionsSync paginated until has_more === false
 *   3. POST each transaction to /v1/raw/ingest as base64-encoded JSON blob
 */

import { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } from "plaid";

const PLAID_CLIENT_ID = process.env["PLAID_CLIENT_ID"];
const PLAID_SECRET = process.env["PLAID_SECRET"];
const PLAID_BASE_PATH: string =
  (PlaidEnvironments[process.env["PLAID_ENV"] as keyof typeof PlaidEnvironments] as string) ??
  PlaidEnvironments.sandbox;
const BRAIN_API_URL = process.env["BRAIN_API_URL"] ?? "http://localhost:3000";
const BRAIN_TOKEN = process.env["BRAIN_TOKEN"];
const INSTITUTION_ID = process.env["PLAID_INSTITUTION_ID"] ?? "ins_109508";

if (!PLAID_CLIENT_ID || !PLAID_SECRET) {
  console.error("PLAID_CLIENT_ID and PLAID_SECRET are required");
  process.exit(1);
}
if (!BRAIN_TOKEN) {
  console.error("BRAIN_TOKEN is required (use: pnpm run dev-token)");
  process.exit(1);
}

const plaidConfig = new Configuration({
  basePath: PLAID_BASE_PATH,
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": PLAID_CLIENT_ID,
      "PLAID-SECRET": PLAID_SECRET,
    },
  },
});
const plaid = new PlaidApi(plaidConfig);

async function ingestTransaction(tx: Record<string, unknown>): Promise<string> {
  const txId = tx["transaction_id"] as string;
  const jsonBytes = Buffer.from(JSON.stringify(tx));

  // Use multipart/form-data so the ingest route accepts the raw bytes
  // without requiring an https:// URL (the JSON body path requires one).
  const form = new FormData();
  form.append("source_type", "plaid");
  form.append("source_ref", txId);
  form.append("file", new Blob([jsonBytes], { type: "application/json" }), `plaid-tx-${txId}.json`);

  const res = await fetch(`${BRAIN_API_URL}/v1/raw/ingest`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${BRAIN_TOKEN}`,
      "idempotency-key": `plaid-sandbox-${txId}`,
    },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ingest failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as { id: string };
  return data.id;
}

async function run(): Promise<void> {
  // 1. Create a sandbox public token for Chase
  console.log(`Creating Plaid Sandbox public token (institution: ${INSTITUTION_ID})...`);
  const sandboxRes = await plaid.sandboxPublicTokenCreate({
    institution_id: INSTITUTION_ID,
    initial_products: [Products.Transactions],
  });
  const publicToken = sandboxRes.data.public_token;

  // 2. Exchange for access token
  const exchangeRes = await plaid.itemPublicTokenExchange({ public_token: publicToken });
  const accessToken = exchangeRes.data.access_token;
  console.log("Access token obtained.");

  // 3. Paginate transactions/sync
  let cursor: string | undefined = undefined;
  let totalIngested = 0;

  do {
    const syncRes = await plaid.transactionsSync({
      access_token: accessToken,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    const { added, has_more, next_cursor } = syncRes.data;

    for (const tx of added) {
      try {
        const rawId = await ingestTransaction(tx as unknown as Record<string, unknown>);
        console.log(`  ingested ${rawId}  (tx: ${tx.transaction_id})`);
        totalIngested++;
      } catch (err) {
        console.error(`  FAILED tx ${tx.transaction_id}:`, (err as Error).message);
      }
    }

    cursor = has_more ? next_cursor : undefined;
  } while (cursor !== undefined);

  console.log(`\nDone. Ingested ${totalIngested} Plaid Sandbox transactions into Brain raw layer.`);
  console.log(
    "Note: transactions land in raw_artifacts only — wiki promotion requires the extractor pipeline (not yet built).",
  );
}

run().catch((err: unknown) => {
  console.error("plaid-sandbox failed:", err);
  process.exit(1);
});
