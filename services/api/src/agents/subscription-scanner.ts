import type { Pool } from "pg";
import {
  startManagedInterval,
  withTenantScope,
  type DomainEvent,
  type ManagedWorker,
  type MetricsEmitter,
  type ServiceCallContext,
} from "@brain/shared";
import type { AgentRunService } from "@brain/agent-router";

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_PER_TENANT_BATCH_SIZE = 25;
const DEFAULT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const SCANNER_ACTOR = "subscription_scanner";
const COOLDOWN_TIER = "subscription";

export interface SubscriptionCandidateRow {
  readonly tenant_id: string;
  readonly transaction_id: string;
  readonly counterparty_id: string;
  readonly amount: string;
  readonly currency: string;
  readonly transaction_date: string;
  readonly history: readonly Record<string, unknown>[];
  readonly event_hint: string;
}

export interface SubscriptionScannerDeps {
  readonly scanPool: Pool;
  readonly appPool: Pool;
  readonly runService: Pick<AgentRunService, "run">;
  readonly metrics?: MetricsEmitter;
  readonly log?: {
    error(obj: unknown, msg?: string): void;
    warn(obj: unknown, msg?: string): void;
  };
}

export interface SubscriptionScannerOptions {
  readonly intervalMs?: number;
  readonly batchSize?: number;
  readonly perTenantBatchSize?: number;
  readonly cooldownMs?: number;
  readonly now?: Date;
}

interface SubscriptionSelection {
  readonly rows: SubscriptionCandidateRow[];
  readonly totalEligible: number;
  readonly totalFair: number;
}

interface SubscriptionDbRow extends Omit<SubscriptionCandidateRow, "history"> {
  readonly history: unknown;
  readonly eligible_count?: number | string;
  readonly fair_count?: number | string;
}

export function startSubscriptionScanner(
  deps: SubscriptionScannerDeps,
  opts: SubscriptionScannerOptions = {},
): ManagedWorker {
  return startManagedInterval(
    () => runSubscriptionScanCycle(deps, opts),
    opts.intervalMs ?? DEFAULT_INTERVAL_MS,
    {
      name: "subscription-scanner",
      runImmediately: false,
      onError: (err) => deps.log?.error({ err }, "subscription scanner failed"),
    },
  );
}

export async function runSubscriptionScanCycle(
  deps: SubscriptionScannerDeps,
  opts: SubscriptionScannerOptions = {},
): Promise<void> {
  const now = opts.now ?? new Date();
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const perTenantBatchSize = opts.perTenantBatchSize ?? DEFAULT_PER_TENANT_BATCH_SIZE;
  const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const selection = await listSubscriptionCandidates(
    deps.scanPool,
    batchSize + 1,
    perTenantBatchSize,
    cooldownMs,
    now,
  );
  const candidates = selection.rows.slice(0, batchSize);
  if (selection.totalFair > batchSize) {
    const omittedCount = Math.max(selection.totalEligible - batchSize, 0);
    deps.log?.warn(
      {
        batchSize,
        perTenantBatchSize,
        total_eligible: selection.totalEligible,
        total_fair: selection.totalFair,
        omitted_count: omittedCount,
      },
      "subscription scanner hit batch cap",
    );
    deps.metrics?.increment(
      "brain.subscription.scan.dropped.count",
      { reason: "batch_cap" },
      omittedCount,
    );
  }

  const perTenant = new Map<string, number>();
  for (const row of candidates) {
    perTenant.set(row.tenant_id, (perTenant.get(row.tenant_id) ?? 0) + 1);
    const event = eventFor(row);
    const triggerKey = `subscription:${event}:${row.transaction_id}`;
    const claimed = await claimCooldown(deps.appPool, row, event, triggerKey, now, cooldownMs);
    if (!claimed) continue;

    let status = "failed";
    let runId: string | null = null;
    let proposalId: string | null = null;
    try {
      const result = await deps.runService.run(ctxFor(row.tenant_id), {
        tenant_id: row.tenant_id,
        event,
        context: {
          transaction_id: row.transaction_id,
          counterparty_id: row.counterparty_id,
          amount: row.amount,
          currency: row.currency,
          transaction_date: row.transaction_date,
          history: row.history,
        },
      });
      status = result.status;
      runId = result.run_id;
      proposalId = result.proposed?.id ?? null;
    } catch (err) {
      deps.log?.error(
        { err, tenantId: row.tenant_id, transactionId: row.transaction_id },
        "subscription run failed",
      );
    } finally {
      await recordCooldownResult(
        deps.appPool,
        row.tenant_id,
        triggerKey,
        status,
        runId,
        proposalId,
      );
    }
  }

  const successUnix = Math.floor(now.getTime() / 1000);
  for (const [tenantId, count] of perTenant.entries()) {
    deps.metrics?.increment("brain.subscription.scan.count", { tenant_id: tenantId }, count);
    deps.metrics?.gauge("brain.subscription.scan.last_success_unixtime", successUnix, {
      tenant_id: tenantId,
    });
  }
}

async function listSubscriptionCandidates(
  pool: Pool,
  limit: number,
  perTenantLimit: number,
  cooldownMs: number,
  now: Date,
): Promise<SubscriptionSelection> {
  const cutoff = new Date(now.getTime() - cooldownMs);
  const { rows } = await pool.query<SubscriptionDbRow>(
    `WITH latest AS (
       SELECT tx.*,
              row_number() OVER (PARTITION BY tx.owner_id, tx.counterparty_id ORDER BY tx.transaction_date DESC, tx.id DESC) AS cp_rank
         FROM ledger_transactions tx
        WHERE tx.direction = 'outflow'
          AND tx.counterparty_id IS NOT NULL
          AND tx.status IN ('posted', 'cleared')
     ),
     candidates AS (
       SELECT l.owner_id AS tenant_id,
              l.id AS transaction_id,
              l.counterparty_id,
              l.amount::text AS amount,
              l.currency,
              l.transaction_date::text AS transaction_date,
              hist.history,
              CASE WHEN hist.prior_avg > 0 AND l.amount > hist.prior_avg * 1.15
                   THEN 'subscription.price_changed'
                   ELSE 'recurring_charge.detected'
              END AS event_hint
         FROM latest l
         JOIN LATERAL (
           SELECT jsonb_agg(
                    jsonb_build_object(
                      'transaction_id', h.id,
                      'amount', h.amount::text,
                      'transaction_date', h.transaction_date::date::text
                    )
                    ORDER BY h.transaction_date ASC, h.id ASC
                  ) AS history,
                  COUNT(*) AS history_count,
                  AVG(h.amount) FILTER (WHERE h.id <> l.id) AS prior_avg
             FROM ledger_transactions h
            WHERE h.owner_id = l.owner_id
              AND h.counterparty_id = l.counterparty_id
              AND h.currency = l.currency
              AND h.direction = 'outflow'
              AND h.status IN ('posted', 'cleared')
         ) hist ON true
        WHERE l.cp_rank = 1
          AND hist.history_count >= 3
     ),
     eligible AS (
       SELECT c.*,
              row_number() OVER (PARTITION BY c.tenant_id ORDER BY c.transaction_date DESC, c.transaction_id ASC) AS tenant_rank,
              COUNT(*) OVER() AS eligible_count
         FROM candidates c
         LEFT JOIN agent_trigger_cooldowns cd
           ON cd.tenant_id = c.tenant_id
          AND cd.agent_key = 'subscription'
          AND cd.receivable_kind = 'transaction'
          AND cd.receivable_id = c.transaction_id
          AND cd.aging_tier = 'subscription'
        WHERE cd.id IS NULL OR cd.last_enqueued_at < $1::timestamptz
     ),
     fair AS (
       SELECT * FROM eligible WHERE tenant_rank <= $2
     )
     SELECT *, COUNT(*) OVER() AS fair_count
       FROM fair
      ORDER BY transaction_date DESC, transaction_id ASC
      LIMIT $3`,
    [cutoff.toISOString(), perTenantLimit, limit],
  );
  return {
    rows: rows.map((row) => ({ ...row, history: readHistory(row.history) })),
    totalEligible: normalizeCount(rows[0]?.eligible_count, rows.length),
    totalFair: normalizeCount(rows[0]?.fair_count, rows.length),
  };
}

async function claimCooldown(
  pool: Pool,
  row: SubscriptionCandidateRow,
  event: DomainEvent,
  triggerKey: string,
  now: Date,
  cooldownMs: number,
): Promise<boolean> {
  const cutoff = new Date(now.getTime() - cooldownMs);
  return withTenantScope(pool, row.tenant_id, async (client) => {
    const { rows } = await client.query<{ trigger_key: string }>(
      `INSERT INTO agent_trigger_cooldowns (
         trigger_key, tenant_id, agent_key, event, receivable_kind, receivable_id,
         aging_tier, last_enqueued_at, last_status
       )
       VALUES ($1, current_setting('app.tenant_id', true), 'subscription', $2, 'transaction', $3,
         $4, $5::timestamptz, 'claimed')
       ON CONFLICT (tenant_id, trigger_key) DO UPDATE SET
         last_enqueued_at = EXCLUDED.last_enqueued_at,
         last_status = 'claimed',
         updated_at = now()
       WHERE agent_trigger_cooldowns.last_enqueued_at < $6::timestamptz
       RETURNING trigger_key`,
      [
        triggerKey,
        event,
        row.transaction_id,
        COOLDOWN_TIER,
        now.toISOString(),
        cutoff.toISOString(),
      ],
    );
    return rows.length > 0;
  });
}

async function recordCooldownResult(
  pool: Pool,
  tenantId: string,
  triggerKey: string,
  status: string,
  runId: string | null,
  proposalId: string | null,
): Promise<void> {
  await withTenantScope(pool, tenantId, async (client) => {
    await client.query(
      `UPDATE agent_trigger_cooldowns
          SET last_status = $2, run_id = $3, proposal_id = $4, updated_at = now()
        WHERE trigger_key = $1`,
      [triggerKey, status, runId, proposalId],
    );
  });
}

function ctxFor(tenantId: string): ServiceCallContext {
  return {
    tenantId,
    actor: SCANNER_ACTOR,
    principalType: "api_partner",
    scopes: ["execution:propose"],
  };
}

function eventFor(row: SubscriptionCandidateRow): DomainEvent {
  return row.event_hint === "subscription.price_changed"
    ? "subscription.price_changed"
    : "recurring_charge.detected";
}

function readHistory(raw: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(raw)
    ? raw.filter(
        (item): item is Record<string, unknown> => typeof item === "object" && item !== null,
      )
    : [];
}

function normalizeCount(value: number | string | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}
