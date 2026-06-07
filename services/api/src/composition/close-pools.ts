/**
 * Graceful shutdown helper: close every DISTINCT database pool exactly once.
 *
 * In single-pool (dev) mode `wikiPool` and `privilegedPool` alias the main
 * `pool`; in production they are separate pools. A Set on the pool references
 * dedupes so an aliased pool is not ended twice (calling `end()` twice on one
 * pg Pool throws "Called end on pool more than once"). `Promise.allSettled`
 * means one pool failing to close never prevents the others from closing.
 * (2026-06-07 review doc A, P2.3.)
 */

export interface Closable {
  end(): Promise<void>;
}

export interface CloseAllPoolsResult {
  /** Number of distinct pools closed. */
  closed: number;
  /** Reasons for any pools that failed to close (the others still closed). */
  errors: unknown[];
}

export async function closeAllPools(pools: ReadonlyArray<Closable>): Promise<CloseAllPoolsResult> {
  const distinct = new Set(pools);
  const results = await Promise.allSettled([...distinct].map((p) => p.end()));
  const errors = results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => r.reason);
  return { closed: distinct.size, errors };
}
