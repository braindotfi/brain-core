/**
 * One-time audit anchor backlog drain.
 *
 * Default mode is dry run. Add --broadcast only after reviewing the batch plan,
 * estimated guarded spend, and wallet floor.
 *
 * Run from repo root:
 *   pnpm --filter @brain/api exec tsx ../../scripts/ops/drain-audit-anchor-backlog.ts --dry-run
 *   pnpm --filter @brain/api exec tsx ../../scripts/ops/drain-audit-anchor-backlog.ts --broadcast --wallet-floor-wei 100000000000000000
 *
 * Required env:
 *   DATABASE_URL or BRAIN_AUDIT_VERIFIER_DB_URL   BYPASSRLS database URL
 *   AUDIT_PUBLISHER_KEY                          0x private key, never logged
 *   AUDIT_ANCHOR_ADDRESS                         BrainAuditAnchor address
 *   BASE_RPC_URL or RPC_URL                      Base Sepolia RPC URL
 */

import { parseArgs } from "node:util";
import { Pool } from "pg";
import {
  createPublicClient,
  http,
  keccak256,
  parseGwei,
  toBytes,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import {
  createViemAnchorBroadcaster,
  MAX_ANCHOR_BATCH_SIZE,
} from "../../services/api/src/anchorBroadcaster.js";
import { chunkRows, dryRunSummary, shouldStopBeforeBatch } from "../lib/audit-anchor-drain.mjs";

const ANCHOR_BATCH_ABI = [
  {
    name: "anchorBatch",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tenantIds", type: "bytes32[]" },
      { name: "roots", type: "bytes32[]" },
      { name: "eventCounts", type: "uint256[]" },
      { name: "periodStarts", type: "uint256[]" },
      { name: "periodEnds", type: "uint256[]" },
    ],
    outputs: [],
  },
  {
    name: "isPublished",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "tenantId", type: "bytes32" },
      { name: "root", type: "bytes32" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

interface AnchorRow {
  id: string;
  tenant_id: string;
  merkle_root: Buffer;
  event_count: number;
  period_start: Date;
  period_end: Date;
}

interface BatchPlan {
  rows: AnchorRow[];
  unpublishedRows: AnchorRow[];
  estimatedCostWei: bigint;
}

function out(message: string): void {
  process.stdout.write(`${message}\n`);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

function requireEnv(name: string): string {
  return env(name) ?? fail(`missing required env: ${name}`);
}

function parsePositiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) fail(`${name} must be a positive integer`);
  return parsed;
}

function parseWei(value: string | undefined, fallback: bigint, name: string): bigint {
  if (value === undefined) return fallback;
  try {
    const parsed = BigInt(value);
    if (parsed < 0n) fail(`${name} must be non-negative wei`);
    return parsed;
  } catch {
    fail(`${name} must be an integer wei value`);
  }
}

function gweiFloor(envName: string, defaultGwei: string): bigint {
  const raw = env(envName) ?? defaultGwei;
  const n = Number(raw);
  return parseGwei(Number.isFinite(n) && n > 0 ? raw : defaultGwei);
}

function applySafetyFactor(costWei: bigint, safetyFactor: number): bigint {
  const factor = Number.isFinite(safetyFactor) && safetyFactor > 0 ? safetyFactor : 1;
  const basisPoints = BigInt(Math.ceil(factor * 10_000));
  return (costWei * basisPoints + 9_999n) / 10_000n;
}

async function loadPending(pool: Pool, limit: number): Promise<AnchorRow[]> {
  const { rows } = await pool.query<AnchorRow>(
    `SELECT id, tenant_id, merkle_root, event_count, period_start, period_end
       FROM audit_anchors
      WHERE onchain_tx_hash IS NULL
        AND onchain_status = 'pending'
      ORDER BY created_at ASC
      LIMIT $1`,
    [limit],
  );
  return rows;
}

async function pendingDepth(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM audit_anchors
      WHERE onchain_tx_hash IS NULL
        AND onchain_status = 'pending'`,
  );
  return Number(rows[0]?.count ?? 0);
}

function toBroadcastInput(row: AnchorRow) {
  return {
    tenantId: row.tenant_id,
    merkleRoot: row.merkle_root,
    eventCount: row.event_count,
    periodStart: row.period_start,
    periodEnd: row.period_end,
  };
}

async function planBatch(input: {
  publicClient: ReturnType<typeof createPublicClient>;
  account: { address: Address };
  contractAddress: Address;
  rows: AnchorRow[];
  gasSafetyFactor: number;
}): Promise<BatchPlan> {
  const unpublishedRows: AnchorRow[] = [];
  for (const row of input.rows) {
    const tenantIdBytes = keccak256(toBytes(row.tenant_id));
    const rootHex = toHex(row.merkle_root);
    const alreadyPublished = await input.publicClient.readContract({
      address: input.contractAddress,
      abi: ANCHOR_BATCH_ABI,
      functionName: "isPublished",
      args: [tenantIdBytes, rootHex],
    });
    if (!alreadyPublished) unpublishedRows.push(row);
  }
  if (unpublishedRows.length === 0) {
    return { rows: input.rows, unpublishedRows, estimatedCostWei: 0n };
  }

  let maxPriorityFeePerGas = gweiFloor("BRAIN_ONCHAIN_MIN_PRIORITY_FEE_GWEI", "0.05");
  let maxFeePerGas = gweiFloor("BRAIN_ONCHAIN_MIN_MAX_FEE_GWEI", "0.5");
  try {
    const est = await input.publicClient.estimateFeesPerGas();
    if (est.maxPriorityFeePerGas > maxPriorityFeePerGas) {
      maxPriorityFeePerGas = est.maxPriorityFeePerGas;
    }
    if (est.maxFeePerGas > maxFeePerGas) maxFeePerGas = est.maxFeePerGas;
  } catch {
    // Fee floors are a safe fallback for dry-run planning.
  }
  if (maxFeePerGas < maxPriorityFeePerGas) maxFeePerGas = maxPriorityFeePerGas;

  const args = [
    unpublishedRows.map((row) => keccak256(toBytes(row.tenant_id))),
    unpublishedRows.map((row) => toHex(row.merkle_root)),
    unpublishedRows.map((row) => BigInt(row.event_count)),
    unpublishedRows.map((row) => BigInt(Math.floor(row.period_start.getTime() / 1000))),
    unpublishedRows.map((row) => BigInt(Math.floor(row.period_end.getTime() / 1000))),
  ] as const;
  const gas = await input.publicClient.estimateContractGas({
    account: input.account,
    address: input.contractAddress,
    abi: ANCHOR_BATCH_ABI,
    functionName: "anchorBatch",
    args,
  });
  return {
    rows: input.rows,
    unpublishedRows,
    estimatedCostWei: applySafetyFactor(gas * maxFeePerGas, input.gasSafetyFactor),
  };
}

async function finalizeRows(
  pool: Pool,
  rows: AnchorRow[],
  results: Awaited<
    ReturnType<ReturnType<typeof createViemAnchorBroadcaster>["broadcastAnchorBatch"]>
  >,
): Promise<void> {
  if (results.length !== rows.length) {
    throw new Error(`expected ${rows.length} batch result(s), got ${results.length}`);
  }
  for (let i = 0; i < rows.length; ++i) {
    const row = rows[i];
    const result = results[i]?.result;
    if (row === undefined || result === undefined) throw new Error("incomplete batch result");
    if (result.status === "reverted") {
      await pool.query(`UPDATE audit_anchors SET onchain_status = 'reverted' WHERE id = $1`, [
        row.id,
      ]);
      continue;
    }
    await pool.query(
      `UPDATE audit_anchors
          SET onchain_tx_hash = $1,
              onchain_block_number = $2,
              onchain_status = 'confirmed'
        WHERE id = $3`,
      [result.txHash, result.blockNumber.toString(), row.id],
    );
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      broadcast: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "batch-size": { type: "string" },
      "max-batches": { type: "string" },
      "wallet-floor-wei": { type: "string" },
      "max-spend-wei": { type: "string" },
    },
  });
  const broadcast = values.broadcast === true;
  const dryRun = !broadcast || values["dry-run"] === true;
  const batchSize = Math.min(
    MAX_ANCHOR_BATCH_SIZE,
    parsePositiveInt(values["batch-size"], MAX_ANCHOR_BATCH_SIZE, "--batch-size"),
  );
  const maxBatches = parsePositiveInt(values["max-batches"], 100, "--max-batches");
  const walletFloorWei = parseWei(values["wallet-floor-wei"], 0n, "--wallet-floor-wei");
  const maxSpendWei = parseWei(values["max-spend-wei"], 2n ** 256n - 1n, "--max-spend-wei");

  const connectionString =
    env("BRAIN_AUDIT_VERIFIER_DB_URL") ?? env("DATABASE_URL") ?? fail("missing DATABASE_URL");
  const privateKey = requireEnv("AUDIT_PUBLISHER_KEY") as Hex;
  const contractAddress = requireEnv("AUDIT_ANCHOR_ADDRESS") as Address;
  const rpcUrl = env("BASE_RPC_URL") ?? env("RPC_URL") ?? fail("missing BASE_RPC_URL or RPC_URL");
  const gasSafetyFactor = Number(env("AUDIT_ANCHOR_GAS_SAFETY_FACTOR") ?? "2");

  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
  const pool = new Pool({ connectionString });
  const broadcaster = createViemAnchorBroadcaster({
    privateKey,
    contractAddress,
    rpcUrl,
    gasSafetyFactor,
    maxBatchSize: batchSize,
    fromBlock:
      env("AUDIT_ANCHOR_FROM_BLOCK") === undefined
        ? undefined
        : BigInt(env("AUDIT_ANCHOR_FROM_BLOCK")!),
  });

  let spentEstimate = 0n;
  let sentBatches = 0;
  let finalizedRows = 0;
  const dryRunPlans: Array<{
    rows: number;
    unpublishedRows: number;
    estimatedCostWei: bigint;
  }> = [];
  try {
    const depthBefore = await pendingDepth(pool);
    out(`pending_backlog_depth=${depthBefore}`);
    const rows = await loadPending(pool, batchSize * maxBatches);
    for (const batchRows of chunkRows(rows, batchSize, maxBatches)) {
      const plan = await planBatch({
        publicClient,
        account,
        contractAddress,
        rows: batchRows,
        gasSafetyFactor,
      });
      out(
        `batch=${sentBatches + 1} rows=${plan.rows.length} unpublished=${plan.unpublishedRows.length} estimated_guarded_cost_wei=${plan.estimatedCostWei}`,
      );
      if (dryRun) {
        dryRunPlans.push({
          rows: plan.rows.length,
          unpublishedRows: plan.unpublishedRows.length,
          estimatedCostWei: plan.estimatedCostWei,
        });
        spentEstimate += plan.estimatedCostWei;
        continue;
      }
      const balance = await publicClient.getBalance({ address: account.address });
      const stopReason = shouldStopBeforeBatch({
        spentEstimateWei: spentEstimate,
        batchEstimatedCostWei: plan.estimatedCostWei,
        maxSpendWei,
        walletBalanceWei: balance,
        walletFloorWei,
      });
      if (stopReason !== null) {
        out(`stopping_before_batch=${stopReason}`);
        break;
      }
      const results = await broadcaster.broadcastAnchorBatch(batchRows.map(toBroadcastInput));
      await finalizeRows(pool, batchRows, results);
      sentBatches += 1;
      finalizedRows += batchRows.length;
      spentEstimate += plan.estimatedCostWei;
    }
    if (dryRun) {
      const summary = dryRunSummary(dryRunPlans);
      out(
        `dry_run_plan batches=${summary.batches} rows=${summary.rows} unpublished=${summary.unpublishedRows} estimated_guarded_spend_wei=${summary.estimatedGuardedSpendWei}`,
      );
    }
    const depthAfter = await pendingDepth(pool);
    out(
      `summary dry_run=${dryRun} sent_batches=${sentBatches} finalized_rows=${finalizedRows} estimated_guarded_spend_wei=${spentEstimate} pending_before=${depthBefore} pending_after=${depthAfter}`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
