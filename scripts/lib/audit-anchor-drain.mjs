export function chunkRows(rows, batchSize, maxBatches = Number.POSITIVE_INFINITY) {
  const size = Math.max(1, Math.floor(batchSize));
  const limit = Math.max(0, Math.floor(maxBatches));
  const chunks = [];
  for (let i = 0; i < rows.length && chunks.length < limit; i += size) {
    chunks.push(rows.slice(i, i + size));
  }
  return chunks;
}

export function shouldStopBeforeBatch({
  spentEstimateWei,
  batchEstimatedCostWei,
  maxSpendWei,
  walletBalanceWei,
  walletFloorWei,
}) {
  if (spentEstimateWei + batchEstimatedCostWei > maxSpendWei) return "max_spend_budget";
  if (walletBalanceWei < walletFloorWei + batchEstimatedCostWei) return "wallet_floor";
  return null;
}

export function dryRunSummary(plans) {
  return plans.reduce(
    (acc, plan) => ({
      batches: acc.batches + 1,
      rows: acc.rows + plan.rows,
      unpublishedRows: acc.unpublishedRows + plan.unpublishedRows,
      estimatedGuardedSpendWei: acc.estimatedGuardedSpendWei + plan.estimatedCostWei,
    }),
    { batches: 0, rows: 0, unpublishedRows: 0, estimatedGuardedSpendWei: 0n },
  );
}
