/**
 * Pure anchor-window computation, shared by the scheduled cross-tenant
 * publisher (services/api/src/main.ts) and the on-demand
 * POST /audit/anchor/publish route so both derive a tenant's next anchor
 * window the same way instead of one of them drifting to a fixed lookback.
 */

/** Caps a single catch-up window (a long-dormant or newly-backfilled tenant)
 * so one cycle never builds one enormous Merkle tree; it closes the backlog
 * over successive cycles instead. */
export const MAX_ANCHOR_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface AnchorWindow {
  periodStart: Date;
  periodEnd: Date;
}

/**
 * The next anchor window for a tenant, given what is already covered
 * (`coveredTo` -- the MAX(period_end) over its non-reverted anchors, or null
 * if the tenant has never been anchored) and the oldest event still waiting
 * to be anchored.
 *
 * periodStart is the LATER of "just after the last covered window" and "the
 * oldest unanchored event", not covered_to + 1ms alone. If the gap since the
 * last anchor is wider than maxWindowMs (a long-quiet tenant), clamping only
 * covered_to + 1ms to maxWindowMs produces a window that ends before
 * oldestUnanchored, so it always contains zero events: createPendingAnchor
 * returns null, covered_to never advances, and the tenant is never anchored
 * again. Taking the max skips straight to where the real backlog starts.
 */
export function nextAnchorWindow(
  coveredTo: Date | null,
  oldestUnanchored: Date,
  now: Date,
  maxWindowMs: number = MAX_ANCHOR_WINDOW_MS,
): AnchorWindow {
  // +1ms is deliberate: listEventsForAnchor uses an inclusive
  // created_at >= start AND created_at <= end, and emitter timestamps are
  // millisecond-precision JS ISO strings, so +1ms starts the next window
  // strictly after the previous window's end without re-anchoring the
  // boundary event. It only applies once a window has actually been covered
  // -- a never-anchored tenant (coveredTo === null) starts at its oldest
  // unanchored event, not at +1ms of anything.
  const afterCovered = coveredTo === null ? oldestUnanchored : new Date(coveredTo.getTime() + 1);
  const periodStart = new Date(Math.max(afterCovered.getTime(), oldestUnanchored.getTime()));

  let periodEnd = now;
  if (periodEnd.getTime() - periodStart.getTime() > maxWindowMs) {
    periodEnd = new Date(periodStart.getTime() + maxWindowMs);
  }
  return { periodStart, periodEnd };
}
