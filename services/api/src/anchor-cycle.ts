export type AnchorCycleReason = "tenant_root_threshold" | "max_wait_elapsed";

export interface AnchorCycleInput {
  readonly pendingRootCount: number;
  readonly eligibleRootCount: number;
  readonly oldestPendingAt: Date | null;
  readonly oldestEligibleAt: Date | null;
  readonly triggerTenantRoots: number;
  readonly maxWaitMs: number;
  readonly now: Date;
}

/**
 * Decides whether to close an anchor cycle without reading or mutating state.
 * Pending rows and eligible rows are disjoint under the scheduler coverage
 * query, so their sum is the number of logical roots accumulated for a batch.
 */
export function anchorCycleReason(input: AnchorCycleInput): AnchorCycleReason | null {
  const rootCount = input.pendingRootCount + input.eligibleRootCount;
  if (rootCount === 0) return null;
  if (rootCount >= input.triggerTenantRoots) return "tenant_root_threshold";

  const oldest = earliest(input.oldestPendingAt, input.oldestEligibleAt);
  if (oldest !== null && input.now.getTime() - oldest.getTime() >= input.maxWaitMs) {
    return "max_wait_elapsed";
  }
  return null;
}

function earliest(left: Date | null, right: Date | null): Date | null {
  if (left === null) return right;
  if (right === null) return left;
  return left.getTime() <= right.getTime() ? left : right;
}
