/**
 * H-09 agent contribution hold.
 *
 * An agent's first `quarantine_threshold` contributions are held
 * out of the extraction pipeline — until a tenant operator releases the agent
 * (sets `contribution_hold_cleared_at`). After release, contributions extract normally.
 * The 0.5 agent-contributed confidence ceiling is unchanged and independent.
 *
 * The pure {@link shouldQuarantineContribution} is the decision; the repo
 * helpers below run tenant-scoped SQL (RLS) and are unit-tested with a fake
 * client. Live DB behavior + the cross-service increment from the Raw ingest
 * path are an integration test, blocked in the sandbox (see the H-09 summary).
 */

import { brainError } from "@brain/shared";
import type { TenantScopedClient } from "@brain/shared";

export interface AgentContributionHoldState {
  /** Contributions counted SO FAR (i.e. AFTER incrementing for this one). */
  contributionCount: number;
  quarantineThreshold: number;
  /** Non-null once an operator has released the contribution hold. */
  contributionHoldClearedAt: Date | null;
}

/**
 * Decide whether a contribution is quarantined. Quarantined iff the agent has
 * NOT been released AND this contribution is within the first
 * `quarantine_threshold`. Fail-safe: an unreleased agent at/under the threshold
 * is held.
 */
export function shouldQuarantineContribution(state: AgentContributionHoldState): boolean {
  if (state.contributionHoldClearedAt !== null) return false;
  return state.contributionCount <= state.quarantineThreshold;
}

/**
 * Atomically increment the agent's contribution counter and return the decision
 * for THIS contribution. The increment + read happen in one statement so
 * concurrent contributions count correctly.
 */
export async function recordContributionAndDecide(
  c: TenantScopedClient,
  agentId: string,
): Promise<{ quarantined: boolean; contributionCount: number } | null> {
  const { rows } = await c.query<{
    contribution_count: number;
    quarantine_threshold: number;
    contribution_hold_cleared_at: Date | null;
  }>(
    `UPDATE agents
        SET contribution_count = contribution_count + 1
      WHERE id = $1
      RETURNING contribution_count, quarantine_threshold, contribution_hold_cleared_at`,
    [agentId],
  );
  const row = rows[0];
  if (row === undefined) return null; // unknown agent (or cross-tenant → RLS hid it)
  const quarantined = shouldQuarantineContribution({
    contributionCount: row.contribution_count,
    quarantineThreshold: row.quarantine_threshold,
    contributionHoldClearedAt: row.contribution_hold_cleared_at,
  });
  return { quarantined, contributionCount: row.contribution_count };
}

/**
 * Release an agent's contribution hold (operator action). Idempotent: re-releasing
 * keeps the original cleared timestamp. Returns false if the agent is not
 * visible to the tenant (→ 404 upstream, no existence leak).
 */
export async function releaseContributionHold(
  c: TenantScopedClient,
  agentId: string,
): Promise<boolean> {
  const { rows } = await c.query<{ id: string }>(
    `UPDATE agents
        SET contribution_hold_cleared_at = COALESCE(contribution_hold_cleared_at, now())
      WHERE id = $1
      RETURNING id`,
    [agentId],
  );
  return rows[0] !== undefined;
}

/** Throwing wrapper for the route: 404 when the agent isn't visible. */
export async function requireReleaseContributionHold(
  c: TenantScopedClient,
  agentId: string,
): Promise<void> {
  const ok = await releaseContributionHold(c, agentId);
  if (!ok) {
    throw brainError("execution_agent_not_registered", `no such agent ${agentId}`, {
      statusOverride: 404,
    });
  }
}
