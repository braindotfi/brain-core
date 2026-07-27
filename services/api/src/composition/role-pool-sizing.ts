import type { PoolName } from "./process-roles.js";

export const DEFAULT_ROLE_POOL_MAX = 3;
export const LEDGER_PROJECTOR_MIN_POOL_MAX = 8;

/**
 * Role pools stay smaller than the request pool by default. The ledger
 * projector is different: it runs three leased workers from one pool, and each
 * lease holds a connection while the cycle body needs more tenant-scoped
 * connections. Keep spare capacity so those leases cannot starve their own work.
 */
export function rolePoolMax(poolName: PoolName, configuredDatabasePoolMax: number): number {
  if (poolName === "ledger_projector") {
    return Math.max(LEDGER_PROJECTOR_MIN_POOL_MAX, configuredDatabasePoolMax);
  }
  return DEFAULT_ROLE_POOL_MAX;
}
