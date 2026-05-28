/**
 * Gate check 8.5 — agent cumulative micropayment window-spend loader
 * (RFC 0001 §6.4).
 *
 * Queries `ledger_payment_intents` under RLS-enforced tenant scope to sum
 * the amount of executed intents created by `agentId` within the trailing
 * `windowSeconds`. Injected into PaymentIntentService at boot; the gate
 * (shared/src/gate/gate.ts:671) hard-rejects when `windowSpend + amount`
 * exceeds the policy envelope's `micropayment_window_cap.value`.
 *
 * Note: the loader is called only when the gate has already verified that
 * `intent.currency === windowCap.currency`, so summing all currencies for
 * the agent is equivalent to summing the matching currency.
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
      const result = await client.query<{ total: string | null }>(
        `SELECT COALESCE(SUM(amount)::text, '0') AS total
           FROM ledger_payment_intents
          WHERE created_by_agent_id = $1
            AND status = 'executed'
            AND updated_at >= now() - ($2 * interval '1 second')`,
        [agentId, windowSeconds],
      );
      return result.rows[0]?.total ?? "0";
    });
  };
}
