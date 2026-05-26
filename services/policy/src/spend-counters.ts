/**
 * policy_spend_counters repository + window math (Agent Autonomy v3, 1b.2).
 *
 * Tumbling windows aligned to the epoch: a window's current bucket holds the
 * aggregate spend/tx-count for that period. The gate reads the current bucket to
 * evaluate agent.spend_in_window / agent.tx_count_in_window, then (on a passing
 * LIVE gate, never dry-run) increments it.
 *
 * NOTE(agent-autonomy-v3): tumbling (not sliding) windows are an approximation —
 * "spend in 24h" is "spend in the current aligned 24h bucket". A sliding window
 * is a follow-up if design partners need exactness.
 */

import type { TenantScopedClient } from "@brain/shared";

const WINDOW_MS: Record<string, number> = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
};

/** Start of the tumbling bucket containing `now` for `window`. */
export function bucketStart(window: string, now: Date = new Date()): Date {
  const ms = WINDOW_MS[window];
  if (ms === undefined) {
    // Unknown window: treat as a single all-time bucket at the epoch.
    return new Date(0);
  }
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

/** Current-bucket spend for (agent, window, currency) as a decimal string. */
export async function readSpendWindow(
  client: TenantScopedClient,
  input: { agentId: string; window: string; currency: string; now?: Date },
): Promise<string> {
  const { rows } = await client.query<{ amount: string }>(
    `SELECT amount::text AS amount FROM policy_spend_counters
      WHERE agent_id = $1 AND period_window = $2 AND currency = $3 AND bucket_start = $4
      LIMIT 1`,
    [input.agentId, input.window, input.currency, bucketStart(input.window, input.now)],
  );
  return rows[0]?.amount ?? "0";
}

/** Current-bucket tx count for (agent, window), summed across currencies. */
export async function readTxCountWindow(
  client: TenantScopedClient,
  input: { agentId: string; window: string; now?: Date },
): Promise<number> {
  const { rows } = await client.query<{ total: string }>(
    `SELECT COALESCE(SUM(tx_count), 0)::text AS total FROM policy_spend_counters
      WHERE agent_id = $1 AND period_window = $2 AND bucket_start = $3`,
    [input.agentId, input.window, bucketStart(input.window, input.now)],
  );
  return Number(rows[0]?.total ?? "0");
}

/**
 * Increment the current bucket by `amount` and one transaction. Upsert keeps the
 * counter atomic under concurrency (1b.2: increment inside the gate tx; rolls
 * back with that tx on rail failure).
 */
export async function incrementSpendCounter(
  client: TenantScopedClient,
  input: {
    id: string;
    tenantId: string;
    agentId: string;
    window: string;
    currency: string;
    amount: string;
    now?: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO policy_spend_counters
       (id, tenant_id, agent_id, period_window, bucket_start, amount, tx_count, currency)
     VALUES ($1,$2,$3,$4,$5,$6,1,$7)
     ON CONFLICT (tenant_id, agent_id, period_window, bucket_start, currency)
     DO UPDATE SET amount = policy_spend_counters.amount + EXCLUDED.amount,
                   tx_count = policy_spend_counters.tx_count + 1`,
    [
      input.id,
      input.tenantId,
      input.agentId,
      input.window,
      bucketStart(input.window, input.now),
      input.amount,
      input.currency,
    ],
  );
}
