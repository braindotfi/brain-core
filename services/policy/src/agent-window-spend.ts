/**
 * Gate check 8.5. Agent cumulative micropayment window-spend loader
 * (RFC 0001 §6.4).
 *
 * Sums `ledger_payment_intents.amount` for the agent's executed intents
 * within the current TUMBLING window, under RLS-enforced tenant scope.
 *
 * Window semantics (R-09 from Opus 4.8 peer review, F-10):
 *   The on-chain `BrainSmartAccount` enforces its session-key budget using
 *   a tumbling window: `window_start = floor(timestamp / periodSeconds) *
 *   periodSeconds`. The off-chain gate used to use a TRAILING ROLLING
 *   window (`updated_at >= now() - windowSeconds`), which diverged from
 *   the on-chain window at boundaries (an intent at T-1h would count in
 *   the rolling window from T but might not count in the tumbling window
 *   if a period rollover happened in between).
 *
 *   This loader now uses the SAME tumbling formula as the contract. The
 *   off-chain check 8.5 (agent-budget) and the on-chain session-key cap
 *   (operator-budget) enforce DIFFERENT subjects (the proposing agent vs
 *   the executing session key), but they now use the same window semantics
 *   so the boundary divergence is gone.
 *
 *   Documented decision (R-09): on-chain `approve` is still counted as
 *   spend by `BrainSmartAccount`. Off-chain only counts `executed`
 *   intents; an off-chain reservation never reaches `executed` until the
 *   rail dispatches, so `approve`-style double-counting is structurally
 *   impossible here.
 *
 * Currency: the loader is called only when the gate has already verified
 * that `intent.currency === windowCap.currency`, so summing all currencies
 * for the agent is equivalent to summing the matching currency.
 */

import { withTenantScope } from "@brain/shared";
import type { Pool } from "pg";
import type { ServiceCallContext } from "@brain/shared";

export function makeSumAgentWindowSpend(
  pool: Pool,
): (ctx: ServiceCallContext, agentId: string, windowSeconds: number) => Promise<string> {
  return async function sumAgentWindowSpend(
    ctx: ServiceCallContext,
    agentId: string,
    windowSeconds: number,
  ): Promise<string> {
    return withTenantScope(pool, ctx.tenantId, async (client) => {
      // Tumbling window: window_start = floor(now_epoch / windowSeconds) *
      // windowSeconds. Mirrors BrainSmartAccount._windowSpent keying so the
      // two enforcers agree at period boundaries.
      const result = await client.query<{ total: string | null }>(
        `SELECT COALESCE(SUM(amount)::text, '0') AS total
           FROM ledger_payment_intents
          WHERE created_by_agent_id = $1
            AND status = 'executed'
            AND updated_at >= to_timestamp(
                  floor(extract(epoch from now()) / $2::numeric) * $2::numeric
                )`,
        [agentId, windowSeconds],
      );
      return result.rows[0]?.total ?? "0";
    });
  };
}
