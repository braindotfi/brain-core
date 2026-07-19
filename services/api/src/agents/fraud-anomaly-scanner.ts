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

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_PER_TENANT_BATCH_SIZE = 25;
const DEFAULT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const SCANNER_ACTOR = "fraud_anomaly_scanner";
const COOLDOWN_TIER = "fraud_anomaly";

export interface FraudAnomalyTransactionRow {
  readonly tenant_id: string;
  readonly transaction_id: string;
  readonly account_id: string;
  readonly amount: string;
  readonly currency: string;
  readonly direction: string;
  readonly transaction_date: string;
  readonly counterparty_id: string | null;
  readonly counterparty_name: string | null;
  readonly description: string | null;
  readonly history_count: string;
  readonly account_mean_amount: string | null;
  readonly account_stddev_amount: string | null;
  readonly counterparty_mean_amount: string | null;
  readonly counterparty_stddev_amount: string | null;
  readonly duplicate_count_7d: string;
  readonly duplicate_transaction_ids: readonly string[];
  readonly velocity_count_24h: string;
  readonly account_daily_count_avg: string | null;
  readonly merchant_risk_score: string | null;
  readonly anomaly_score: string;
  readonly event_hint: string;
}

export interface FraudAnomalyScannerDeps {
  readonly scanPool: Pool;
  readonly appPool: Pool;
  readonly runService: Pick<AgentRunService, "run">;
  readonly metrics?: MetricsEmitter;
  readonly log?: {
    error(obj: unknown, msg?: string): void;
    warn(obj: unknown, msg?: string): void;
    info?(obj: unknown, msg?: string): void;
  };
}

export interface FraudAnomalyScannerOptions {
  readonly intervalMs?: number;
  readonly batchSize?: number;
  readonly perTenantBatchSize?: number;
  readonly cooldownMs?: number;
  readonly now?: Date;
}

interface FraudAnomalySelection {
  readonly rows: FraudAnomalyTransactionRow[];
  readonly totalEligible: number;
  readonly totalFair: number;
}

interface FraudAnomalyDbRow extends Omit<FraudAnomalyTransactionRow, "duplicate_transaction_ids"> {
  readonly duplicate_transaction_ids: unknown;
  readonly eligible_count?: number | string;
  readonly fair_count?: number | string;
}

export function startFraudAnomalyScanner(
  deps: FraudAnomalyScannerDeps,
  opts: FraudAnomalyScannerOptions = {},
): ManagedWorker {
  return startManagedInterval(
    () => runFraudAnomalyScanCycle(deps, opts),
    opts.intervalMs ?? DEFAULT_INTERVAL_MS,
    {
      name: "fraud-anomaly-scanner",
      runImmediately: false,
      onError: (err) => deps.log?.error({ err }, "fraud anomaly scanner failed"),
    },
  );
}

export async function runFraudAnomalyScanCycle(
  deps: FraudAnomalyScannerDeps,
  opts: FraudAnomalyScannerOptions = {},
): Promise<void> {
  const now = opts.now ?? new Date();
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const perTenantBatchSize = opts.perTenantBatchSize ?? DEFAULT_PER_TENANT_BATCH_SIZE;
  const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const selection = await listAnomalousTransactions(
    deps.scanPool,
    now,
    batchSize + 1,
    perTenantBatchSize,
    cooldownMs,
  );
  const capped = selection.totalFair > batchSize;
  const transactions = selection.rows.slice(0, batchSize);
  if (capped) {
    const omittedCount = Math.max(selection.totalEligible - batchSize, 0);
    deps.log?.warn(
      {
        batchSize,
        perTenantBatchSize,
        total_eligible: selection.totalEligible,
        total_fair: selection.totalFair,
        omitted_count: omittedCount,
      },
      "fraud anomaly scanner hit batch cap",
    );
    deps.metrics?.increment(
      "brain.fraud_anomaly.scan.dropped.count",
      { reason: "batch_cap" },
      omittedCount,
    );
  }

  const perTenant = new Map<string, number>();
  for (const row of transactions) {
    perTenant.set(row.tenant_id, (perTenant.get(row.tenant_id) ?? 0) + 1);
    const event = eventFor(row);
    const triggerKey = triggerKeyFor(row, event);
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
          account_id: row.account_id,
          amount: row.amount,
          currency: row.currency,
          direction: row.direction,
          transaction_date: row.transaction_date,
          counterparty_id: row.counterparty_id,
          counterparty_name: row.counterparty_name,
          description: row.description,
          history_count: row.history_count,
          account_mean_amount: row.account_mean_amount,
          account_stddev_amount: row.account_stddev_amount,
          counterparty_mean_amount: row.counterparty_mean_amount,
          counterparty_stddev_amount: row.counterparty_stddev_amount,
          duplicate_count_7d: row.duplicate_count_7d,
          duplicate_transaction_ids: row.duplicate_transaction_ids,
          velocity_count_24h: row.velocity_count_24h,
          account_daily_count_avg: row.account_daily_count_avg,
          merchant_risk_score: row.merchant_risk_score,
        },
      });
      status = result.status;
      runId = result.run_id;
      proposalId = result.proposed?.id ?? null;
    } catch (err) {
      deps.log?.error(
        { err, tenantId: row.tenant_id, transactionId: row.transaction_id },
        "fraud anomaly run failed",
      );
      status = "failed";
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
    deps.metrics?.increment("brain.fraud_anomaly.scan.count", { tenant_id: tenantId }, count);
    deps.metrics?.gauge("brain.fraud_anomaly.scan.last_success_unixtime", successUnix, {
      tenant_id: tenantId,
    });
  }
}

async function listAnomalousTransactions(
  pool: Pool,
  now: Date,
  limit: number,
  perTenantLimit: number,
  cooldownMs: number,
): Promise<FraudAnomalySelection> {
  const cutoff = new Date(now.getTime() - cooldownMs);
  const { rows } = await pool.query<FraudAnomalyDbRow>(
    `WITH base AS (
       SELECT tx.owner_id AS tenant_id,
              tx.id AS transaction_id,
              tx.account_id,
              tx.amount,
              tx.currency,
              tx.direction,
              tx.transaction_date,
              tx.counterparty_id,
              cp.name AS counterparty_name,
              COALESCE(tx.description_normalized, tx.description_raw) AS description,
              cp.risk_level AS counterparty_risk_level
         FROM ledger_transactions tx
         LEFT JOIN ledger_counterparties cp
           ON cp.id = tx.counterparty_id AND cp.owner_id = tx.owner_id
        WHERE tx.status IN ('posted', 'cleared')
          AND tx.direction IN ('outflow', 'transfer')
          AND tx.transaction_date >= $1::timestamptz - interval '30 days'
          AND tx.transaction_date <= $1::timestamptz
     ),
     enriched AS (
       SELECT b.*,
              COALESCE(account_history.history_count, 0) AS account_history_count,
              account_history.mean_amount AS account_mean_amount,
              account_history.stddev_amount AS account_stddev_amount,
              COALESCE(counterparty_history.history_count, 0) AS counterparty_history_count,
              counterparty_history.mean_amount AS counterparty_mean_amount,
              counterparty_history.stddev_amount AS counterparty_stddev_amount,
              COALESCE(duplicates.duplicate_count, 0) AS duplicate_count_7d,
              COALESCE(duplicates.duplicate_ids, '[]'::jsonb) AS duplicate_transaction_ids,
              COALESCE(velocity.velocity_count, 1) AS velocity_count_24h,
              account_history.daily_count_avg AS account_daily_count_avg,
              CASE
                WHEN b.counterparty_risk_level = 'sanctioned' THEN 1.0
                WHEN b.counterparty_risk_level = 'high' THEN 0.85
                ELSE NULL
              END AS merchant_risk_score
         FROM base b
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS history_count,
                  AVG(h.amount) AS mean_amount,
                  STDDEV_POP(h.amount) AS stddev_amount,
                  COUNT(*)::numeric / 30 AS daily_count_avg
             FROM ledger_transactions h
            WHERE h.owner_id = b.tenant_id
              AND h.account_id = b.account_id
              AND h.id <> b.transaction_id
              AND h.status IN ('posted', 'cleared')
              AND h.direction = b.direction
              AND h.transaction_date < b.transaction_date
              AND h.transaction_date >= b.transaction_date - interval '180 days'
         ) account_history ON true
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS history_count,
                  AVG(h.amount) AS mean_amount,
                  STDDEV_POP(h.amount) AS stddev_amount
             FROM ledger_transactions h
            WHERE h.owner_id = b.tenant_id
              AND h.counterparty_id IS NOT DISTINCT FROM b.counterparty_id
              AND h.id <> b.transaction_id
              AND h.status IN ('posted', 'cleared')
              AND h.direction = b.direction
              AND h.transaction_date < b.transaction_date
              AND h.transaction_date >= b.transaction_date - interval '180 days'
         ) counterparty_history ON true
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS duplicate_count,
                  jsonb_agg(d.id ORDER BY d.transaction_date DESC, d.id ASC) AS duplicate_ids
             FROM ledger_transactions d
            WHERE d.owner_id = b.tenant_id
              AND d.account_id = b.account_id
              AND d.id <> b.transaction_id
              AND d.status IN ('posted', 'cleared')
              AND d.direction = b.direction
              AND d.currency = b.currency
              AND d.amount = b.amount
              AND d.counterparty_id IS NOT DISTINCT FROM b.counterparty_id
              AND d.transaction_date >= b.transaction_date - interval '7 days'
              AND d.transaction_date <= b.transaction_date
         ) duplicates ON true
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS velocity_count
             FROM ledger_transactions v
            WHERE v.owner_id = b.tenant_id
              AND v.account_id = b.account_id
              AND v.status IN ('posted', 'cleared')
              AND v.direction = b.direction
              AND v.transaction_date >= b.transaction_date - interval '24 hours'
              AND v.transaction_date <= b.transaction_date
         ) velocity ON true
     ),
     scored AS (
       SELECT e.*,
              GREATEST(e.account_history_count, e.counterparty_history_count) AS history_count,
              GREATEST(
                CASE WHEN e.duplicate_count_7d >= 1 THEN 0.95 ELSE 0 END,
                COALESCE(e.merchant_risk_score, 0),
                CASE
                  WHEN GREATEST(e.account_history_count, e.counterparty_history_count) < 3 THEN 0
                  WHEN e.counterparty_mean_amount > 0 AND e.amount / e.counterparty_mean_amount >= 10 THEN 0.9
                  WHEN e.account_mean_amount > 0 AND e.amount / e.account_mean_amount >= 10 THEN 0.9
                  WHEN e.counterparty_mean_amount > 0 AND e.amount / e.counterparty_mean_amount >= 4 THEN 0.72
                  WHEN e.account_mean_amount > 0 AND e.amount / e.account_mean_amount >= 4 THEN 0.72
                  WHEN e.counterparty_stddev_amount > 0
                   AND (e.amount - e.counterparty_mean_amount) / e.counterparty_stddev_amount >= 4 THEN 0.85
                  WHEN e.account_stddev_amount > 0
                   AND (e.amount - e.account_mean_amount) / e.account_stddev_amount >= 4 THEN 0.85
                  WHEN e.counterparty_stddev_amount > 0
                   AND (e.amount - e.counterparty_mean_amount) / e.counterparty_stddev_amount >= 3 THEN 0.7
                  WHEN e.account_stddev_amount > 0
                   AND (e.amount - e.account_mean_amount) / e.account_stddev_amount >= 3 THEN 0.7
                  WHEN e.account_daily_count_avg > 0
                   AND e.velocity_count_24h / e.account_daily_count_avg >= 4 THEN 0.65
                  WHEN e.velocity_count_24h >= 5 THEN 0.65
                  ELSE 0
                END
              ) AS anomaly_score
         FROM enriched e
     ),
     eligible AS (
       SELECT s.*,
              CASE
                WHEN s.duplicate_count_7d >= 1 THEN 'duplicate_charge.detected'
                WHEN s.merchant_risk_score >= 0.8 THEN 'merchant.risk_detected'
                ELSE 'transaction.unusual'
              END AS event_hint,
              row_number() OVER (
                PARTITION BY s.tenant_id
                ORDER BY s.anomaly_score DESC, s.transaction_date DESC, s.transaction_id ASC
              ) AS tenant_rank,
              COUNT(*) OVER() AS eligible_count
         FROM scored s
         LEFT JOIN agent_trigger_cooldowns cd
           ON cd.tenant_id = s.tenant_id
          AND cd.agent_key = 'fraud_anomaly'
          AND cd.receivable_kind = 'transaction'
          AND cd.receivable_id = s.transaction_id
          AND cd.aging_tier = 'fraud_anomaly'
        WHERE s.anomaly_score >= 0.5
          AND (cd.id IS NULL OR cd.last_enqueued_at < $2::timestamptz)
     ),
     fair AS (
       SELECT *
         FROM eligible
        WHERE tenant_rank <= $3
     )
     SELECT tenant_id,
            transaction_id,
            account_id,
            amount::text AS amount,
            currency,
            direction,
            transaction_date::text AS transaction_date,
            counterparty_id,
            counterparty_name,
            description,
            history_count::text AS history_count,
            account_mean_amount::text AS account_mean_amount,
            account_stddev_amount::text AS account_stddev_amount,
            counterparty_mean_amount::text AS counterparty_mean_amount,
            counterparty_stddev_amount::text AS counterparty_stddev_amount,
            duplicate_count_7d::text AS duplicate_count_7d,
            duplicate_transaction_ids,
            velocity_count_24h::text AS velocity_count_24h,
            account_daily_count_avg::text AS account_daily_count_avg,
            merchant_risk_score::text AS merchant_risk_score,
            anomaly_score::text AS anomaly_score,
            event_hint,
            eligible_count,
            COUNT(*) OVER() AS fair_count
       FROM fair
      ORDER BY anomaly_score DESC, transaction_date DESC, transaction_id ASC
      LIMIT $4`,
    [now.toISOString(), cutoff.toISOString(), perTenantLimit, limit],
  );
  const totalEligible = normalizeCount(rows[0]?.eligible_count, rows.length);
  const totalFair = normalizeCount(rows[0]?.fair_count, rows.length);
  return {
    rows: rows.map((row) => ({
      ...row,
      duplicate_transaction_ids: normalizeStringArray(row.duplicate_transaction_ids),
    })),
    totalEligible,
    totalFair,
  };
}

async function claimCooldown(
  pool: Pool,
  row: FraudAnomalyTransactionRow,
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
       VALUES (
         $1, current_setting('app.tenant_id', true), 'fraud_anomaly', $2, 'transaction', $3,
         $4, $5::timestamptz, 'claimed'
       )
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
          SET last_status = $2,
              run_id = $3,
              proposal_id = $4,
              updated_at = now()
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

function eventFor(row: FraudAnomalyTransactionRow): DomainEvent {
  if (
    row.event_hint === "duplicate_charge.detected" ||
    row.event_hint === "merchant.risk_detected"
  ) {
    return row.event_hint;
  }
  return "transaction.unusual";
}

function triggerKeyFor(row: FraudAnomalyTransactionRow, event: DomainEvent): string {
  return `fraud_anomaly:${event}:transaction:${row.transaction_id}:${COOLDOWN_TIER}`;
}

function normalizeCount(value: number | string | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function normalizeStringArray(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return normalizeStringArray(parsed);
    } catch {
      return [];
    }
  }
  return [];
}
