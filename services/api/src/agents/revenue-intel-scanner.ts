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
const DEFAULT_COOLDOWN_MS = 12 * 60 * 60 * 1000;
const SCANNER_ACTOR = "revenue_intel_scanner";
const COOLDOWN_TIER = "revenue_intel";

export interface RevenueIntelCandidateRow {
  readonly tenant_id: string;
  readonly counterparty_id: string;
  readonly invoice_id: string;
  readonly transaction_id: string;
  readonly currency: string;
  readonly current_period_revenue: string;
  readonly prior_period_revenue: string;
  readonly current_dso: string;
  readonly prior_dso: string;
  readonly event_hint: string;
  readonly detected_at: string;
}

export interface RevenueIntelScannerDeps {
  readonly scanPool: Pool;
  readonly appPool: Pool;
  readonly runService: Pick<AgentRunService, "run">;
  readonly metrics?: MetricsEmitter;
  readonly log?: {
    error(obj: unknown, msg?: string): void;
    warn(obj: unknown, msg?: string): void;
  };
}

export interface RevenueIntelScannerOptions {
  readonly intervalMs?: number;
  readonly batchSize?: number;
  readonly perTenantBatchSize?: number;
  readonly cooldownMs?: number;
  readonly now?: Date;
}

interface RevenueIntelSelection {
  readonly rows: RevenueIntelCandidateRow[];
  readonly totalEligible: number;
  readonly totalFair: number;
}

interface RevenueIntelDbRow extends RevenueIntelCandidateRow {
  readonly eligible_count?: number | string;
  readonly fair_count?: number | string;
}

export function startRevenueIntelScanner(
  deps: RevenueIntelScannerDeps,
  opts: RevenueIntelScannerOptions = {},
): ManagedWorker {
  return startManagedInterval(
    () => runRevenueIntelScanCycle(deps, opts),
    opts.intervalMs ?? DEFAULT_INTERVAL_MS,
    {
      name: "revenue-intel-scanner",
      runImmediately: false,
      onError: (err) => deps.log?.error({ err }, "revenue intel scanner failed"),
    },
  );
}

export async function runRevenueIntelScanCycle(
  deps: RevenueIntelScannerDeps,
  opts: RevenueIntelScannerOptions = {},
): Promise<void> {
  const now = opts.now ?? new Date();
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const perTenantBatchSize = opts.perTenantBatchSize ?? DEFAULT_PER_TENANT_BATCH_SIZE;
  const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const selection = await listRevenueIntelCandidates(
    deps.scanPool,
    now,
    batchSize + 1,
    perTenantBatchSize,
    cooldownMs,
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
      "revenue intel scanner hit batch cap",
    );
    deps.metrics?.increment(
      "brain.revenue_intel.scan.dropped.count",
      { reason: "batch_cap" },
      omittedCount,
    );
  }

  const perTenant = new Map<string, number>();
  for (const row of candidates) {
    perTenant.set(row.tenant_id, (perTenant.get(row.tenant_id) ?? 0) + 1);
    const event = eventFor(row);
    const triggerKey = `revenue_intel:${event}:${row.counterparty_id}`;
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
          counterparty_id: row.counterparty_id,
          invoice_id: row.invoice_id,
          transaction_id: row.transaction_id,
          currency: row.currency,
          current_period_revenue: row.current_period_revenue,
          prior_period_revenue: row.prior_period_revenue,
          current_dso: row.current_dso,
          prior_dso: row.prior_dso,
        },
      });
      status = result.status;
      runId = result.run_id;
      proposalId = result.proposed?.id ?? null;
    } catch (err) {
      deps.log?.error(
        { err, tenantId: row.tenant_id, counterpartyId: row.counterparty_id },
        "revenue intel run failed",
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
    deps.metrics?.increment("brain.revenue_intel.scan.count", { tenant_id: tenantId }, count);
    deps.metrics?.gauge("brain.revenue_intel.scan.last_success_unixtime", successUnix, {
      tenant_id: tenantId,
    });
  }
}

async function listRevenueIntelCandidates(
  pool: Pool,
  now: Date,
  limit: number,
  perTenantLimit: number,
  cooldownMs: number,
): Promise<RevenueIntelSelection> {
  const cutoff = new Date(now.getTime() - cooldownMs);
  const { rows } = await pool.query<RevenueIntelDbRow>(
    `WITH invoice_periods AS (
       SELECT i.owner_id AS tenant_id,
              i.counterparty_id,
              i.currency,
              SUM(i.amount_paid) FILTER (WHERE i.issue_date >= $2::timestamptz - INTERVAL '30 days') AS current_revenue,
              SUM(i.amount_paid) FILTER (
                WHERE i.issue_date < $2::timestamptz - INTERVAL '30 days'
                  AND i.issue_date >= $2::timestamptz - INTERVAL '60 days'
              ) AS prior_revenue,
              AVG(GREATEST(0, EXTRACT(EPOCH FROM ((COALESCE(i.due_date, i.issue_date)) - i.issue_date)) / 86400))
                FILTER (WHERE i.issue_date >= $2::timestamptz - INTERVAL '30 days') AS current_dso,
              AVG(GREATEST(0, EXTRACT(EPOCH FROM ((COALESCE(i.due_date, i.issue_date)) - i.issue_date)) / 86400))
                FILTER (
                  WHERE i.issue_date < $2::timestamptz - INTERVAL '30 days'
                    AND i.issue_date >= $2::timestamptz - INTERVAL '60 days'
                ) AS prior_dso,
              MAX(i.updated_at) AS detected_at
         FROM ledger_invoices i
        WHERE i.status IN ('sent', 'partial', 'paid', 'overdue')
        GROUP BY i.owner_id, i.counterparty_id, i.currency
     ),
     candidates AS (
       SELECT p.tenant_id,
              p.counterparty_id,
              inv.id AS invoice_id,
              tx.id AS transaction_id,
              p.currency,
              COALESCE(p.current_revenue, 0)::text AS current_period_revenue,
              COALESCE(p.prior_revenue, 0)::text AS prior_period_revenue,
              COALESCE(p.current_dso, 0)::text AS current_dso,
              COALESCE(p.prior_dso, 0)::text AS prior_dso,
              CASE
                WHEN COALESCE(p.current_dso, 0) - COALESCE(p.prior_dso, 0) >= 10 THEN 'customer.payment_behavior_changed'
                ELSE 'revenue.changed'
              END AS event_hint,
              p.detected_at::text AS detected_at
         FROM invoice_periods p
         JOIN LATERAL (
           SELECT i.id
             FROM ledger_invoices i
            WHERE i.owner_id = p.tenant_id
              AND i.counterparty_id = p.counterparty_id
              AND i.currency = p.currency
            ORDER BY i.issue_date DESC, i.id DESC
            LIMIT 1
         ) inv ON true
         JOIN LATERAL (
           SELECT t.id
             FROM ledger_transactions t
            WHERE t.owner_id = p.tenant_id
              AND t.counterparty_id = p.counterparty_id
              AND t.currency = p.currency
            ORDER BY t.transaction_date DESC, t.id DESC
            LIMIT 1
         ) tx ON true
        WHERE ABS(COALESCE(p.current_revenue, 0) - COALESCE(p.prior_revenue, 0)) > 0
           OR COALESCE(p.current_dso, 0) - COALESCE(p.prior_dso, 0) >= 10
     ),
     eligible AS (
       SELECT c.*,
              row_number() OVER (PARTITION BY c.tenant_id ORDER BY c.detected_at DESC, c.counterparty_id ASC) AS tenant_rank,
              COUNT(*) OVER() AS eligible_count
         FROM candidates c
         LEFT JOIN agent_trigger_cooldowns cd
           ON cd.tenant_id = c.tenant_id
          AND cd.agent_key = 'revenue_intel'
          AND cd.receivable_kind = 'counterparty'
          AND cd.receivable_id = c.counterparty_id
          AND cd.aging_tier = 'revenue_intel'
        WHERE cd.id IS NULL OR cd.last_enqueued_at < $1::timestamptz
     ),
     fair AS (
       SELECT * FROM eligible WHERE tenant_rank <= $3
     )
     SELECT *, COUNT(*) OVER() AS fair_count
       FROM fair
      ORDER BY detected_at DESC, counterparty_id ASC
      LIMIT $4`,
    [cutoff.toISOString(), now.toISOString(), perTenantLimit, limit],
  );
  return {
    rows,
    totalEligible: normalizeCount(rows[0]?.eligible_count, rows.length),
    totalFair: normalizeCount(rows[0]?.fair_count, rows.length),
  };
}

async function claimCooldown(
  pool: Pool,
  row: RevenueIntelCandidateRow,
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
       VALUES ($1, current_setting('app.tenant_id', true), 'revenue_intel', $2, 'counterparty', $3,
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
        row.counterparty_id,
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

function eventFor(row: RevenueIntelCandidateRow): DomainEvent {
  return row.event_hint === "customer.payment_behavior_changed"
    ? "customer.payment_behavior_changed"
    : "revenue.changed";
}

function normalizeCount(value: number | string | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}
