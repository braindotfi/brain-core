import assert from "node:assert/strict";
import test from "node:test";
import { chunkRows, dryRunSummary, shouldStopBeforeBatch } from "../lib/audit-anchor-drain.mjs";

test("audit anchor drain dry-run chunks rows without sending", () => {
  const rows = Array.from({ length: 7 }, (_, i) => ({ id: `anchor_${i}` }));
  const chunks = chunkRows(rows, 3, 10);
  const summary = dryRunSummary(
    chunks.map((chunk) => ({
      rows: chunk.length,
      unpublishedRows: chunk.length,
      estimatedCostWei: 100n,
    })),
  );

  assert.deepEqual(
    chunks.map((chunk) => chunk.map((row) => row.id)),
    [["anchor_0", "anchor_1", "anchor_2"], ["anchor_3", "anchor_4", "anchor_5"], ["anchor_6"]],
  );
  assert.equal(summary.batches, 3);
  assert.equal(summary.rows, 7);
  assert.equal(summary.estimatedGuardedSpendWei, 300n);
});

test("audit anchor drain budget ceiling stops before a batch", () => {
  assert.equal(
    shouldStopBeforeBatch({
      spentEstimateWei: 900n,
      batchEstimatedCostWei: 200n,
      maxSpendWei: 1_000n,
      walletBalanceWei: 10_000n,
      walletFloorWei: 0n,
    }),
    "max_spend_budget",
  );
  assert.equal(
    shouldStopBeforeBatch({
      spentEstimateWei: 0n,
      batchEstimatedCostWei: 700n,
      maxSpendWei: 10_000n,
      walletBalanceWei: 1_000n,
      walletFloorWei: 500n,
    }),
    "wallet_floor",
  );
  assert.equal(
    shouldStopBeforeBatch({
      spentEstimateWei: 0n,
      batchEstimatedCostWei: 400n,
      maxSpendWei: 10_000n,
      walletBalanceWei: 1_000n,
      walletFloorWei: 500n,
    }),
    null,
  );
});

test("audit anchor drain resume plan can account for already anchored rows", () => {
  const summary = dryRunSummary([
    { rows: 3, unpublishedRows: 1, estimatedCostWei: 50n },
    { rows: 2, unpublishedRows: 0, estimatedCostWei: 0n },
  ]);

  assert.equal(summary.rows, 5);
  assert.equal(summary.unpublishedRows, 1);
  assert.equal(summary.estimatedGuardedSpendWei, 50n);
});
