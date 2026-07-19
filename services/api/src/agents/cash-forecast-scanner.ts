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

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_PER_TENANT_BATCH_SIZE = 10;
const DEFAULT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MATERIAL_CHANGE_MIN_AMOUNT = 10_000;
const DEFAULT_MATERIAL_CHANGE_RATIO = 0.1;
const DEFAULT_LARGE_PAYABLE_AMOUNT = 25_000;
const SCANNER_ACTOR = "cash_forecast_scanner";
const COOLDOWN_TIER = "forecast";

export interface CashForecastFlowContext {
  readonly invoice_id?: string;
  readonly obligation_id?: string;
  readonly amount: string;
  readonly currency: string;
  readonly due_date: string;
  readonly counterparty_id: string | null;
  readonly counterparty_name: string | null;
}

export interface CashForecastPositionRow {
  readonly tenant_id: string;
  readonly currency: string;
  readonly balance_id: string;
  readonly current_balance: string;
  readonly as_of: string;
  readonly receivables: readonly CashForecastFlowContext[];
  readonly payables: readonly CashForecastFlowContext[];
  readonly total_flow_amount: string;
  readonly max_payable_amount: string;
}

export interface CashForecastScannerDeps {
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

export interface CashForecastScannerOptions {
  readonly intervalMs?: number;
  readonly batchSize?: number;
  readonly perTenantBatchSize?: number;
  readonly cooldownMs?: number;
  readonly materialChangeMinAmount?: number;
  readonly materialChangeRatio?: number;
  readonly largePayableAmount?: number;
  readonly now?: Date;
}

interface CashForecastSelection {
  readonly rows: CashForecastPositionRow[];
  readonly totalEligible: number;
  readonly totalFair: number;
}

interface CashForecastDbRow extends Omit<CashForecastPositionRow, "receivables" | "payables"> {
  readonly receivables: unknown;
  readonly payables: unknown;
  readonly eligible_count?: number | string;
  readonly fair_count?: number | string;
}

export function startCashForecastScanner(
  deps: CashForecastScannerDeps,
  opts: CashForecastScannerOptions = {},
): ManagedWorker {
  return startManagedInterval(
    () => runCashForecastScanCycle(deps, opts),
    opts.intervalMs ?? DEFAULT_INTERVAL_MS,
    {
      name: "cash-forecast-scanner",
      runImmediately: false,
      onError: (err) => deps.log?.error({ err }, "cash forecast scanner failed"),
    },
  );
}

export async function runCashForecastScanCycle(
  deps: CashForecastScannerDeps,
  opts: CashForecastScannerOptions = {},
): Promise<void> {
  const now = opts.now ?? new Date();
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const perTenantBatchSize = opts.perTenantBatchSize ?? DEFAULT_PER_TENANT_BATCH_SIZE;
  const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const selection = await listCashForecastPositions(
    deps.scanPool,
    now,
    batchSize + 1,
    perTenantBatchSize,
    cooldownMs,
  );
  const capped = selection.totalFair > batchSize;
  const positions = selection.rows.slice(0, batchSize);
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
      "cash forecast scanner hit batch cap",
    );
    deps.metrics?.increment(
      "brain.cash_forecast.scan.dropped.count",
      { reason: "batch_cap" },
      omittedCount,
    );
  }

  const perTenant = new Map<string, number>();
  for (const row of positions) {
    perTenant.set(row.tenant_id, (perTenant.get(row.tenant_id) ?? 0) + 1);
    const event = eventFor(row, opts);
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
          balance_id: row.balance_id,
          current_balance: row.current_balance,
          currency: row.currency,
          as_of: row.as_of,
          receivables: row.receivables,
          payables: row.payables,
        },
      });
      status = result.status;
      runId = result.run_id;
      proposalId = result.proposed?.id ?? null;
    } catch (err) {
      deps.log?.error(
        { err, tenantId: row.tenant_id, balanceId: row.balance_id },
        "cash forecast run failed",
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
    deps.metrics?.increment("brain.cash_forecast.scan.count", { tenant_id: tenantId }, count);
    deps.metrics?.gauge("brain.cash_forecast.scan.last_success_unixtime", successUnix, {
      tenant_id: tenantId,
    });
  }
}

async function listCashForecastPositions(
  pool: Pool,
  now: Date,
  limit: number,
  perTenantLimit: number,
  cooldownMs: number,
): Promise<CashForecastSelection> {
  const cutoff = new Date(now.getTime() - cooldownMs);
  const { rows } = await pool.query<CashForecastDbRow>(
    `WITH latest_balances AS (
       SELECT *
         FROM (
           SELECT b.*,
                  row_number() OVER (
                    PARTITION BY b.owner_id, b.account_id
                    ORDER BY b.as_of DESC, b.id ASC
                  ) AS balance_rank
             FROM ledger_balances b
             JOIN ledger_accounts a
               ON a.id = b.account_id AND a.owner_id = b.owner_id
            WHERE a.status = 'active'
         ) ranked
        WHERE balance_rank = 1
     ),
     position AS (
       SELECT owner_id AS tenant_id,
              currency,
              (array_agg(id ORDER BY as_of DESC, id ASC))[1] AS balance_id,
              SUM(current_balance)::text AS current_balance,
              MAX(as_of) AS as_of
         FROM latest_balances
        GROUP BY owner_id, currency
     ),
     with_flows AS (
       SELECT p.*,
              COALESCE(receivable.items, '[]'::jsonb) AS receivables,
              COALESCE(payable.items, '[]'::jsonb) AS payables,
              (
                COALESCE(receivable.total_amount, 0) +
                COALESCE(payable.total_amount, 0)
              )::text AS total_flow_amount,
              COALESCE(payable.max_amount, 0)::text AS max_payable_amount
         FROM position p
         LEFT JOIN LATERAL (
           SELECT jsonb_agg(
                    jsonb_build_object(
                      'invoice_id', i.id,
                      'amount', (i.amount_due - i.amount_paid)::text,
                      'currency', i.currency,
                      'due_date', i.due_date::text,
                      'counterparty_id', i.counterparty_id,
                      'counterparty_name', cp.name
                    )
                    ORDER BY i.due_date ASC, i.id ASC
                  ) AS items,
                  SUM(i.amount_due - i.amount_paid) AS total_amount
             FROM ledger_invoices i
             JOIN ledger_counterparties cp
               ON cp.id = i.counterparty_id AND cp.owner_id = i.owner_id
            WHERE i.owner_id = p.tenant_id
              AND i.currency = p.currency
              AND i.due_date >= $1::timestamptz
              AND i.due_date <= $1::timestamptz + interval '90 days'
              AND i.status IN ('sent', 'partial', 'overdue')
              AND i.amount_paid < i.amount_due
         ) receivable ON true
         LEFT JOIN LATERAL (
           SELECT jsonb_agg(
                    jsonb_build_object(
                      'obligation_id', o.id,
                      'amount', o.amount_due::text,
                      'currency', o.currency,
                      'due_date', o.due_date::text,
                      'counterparty_id', o.counterparty_id,
                      'counterparty_name', cp.name
                    )
                    ORDER BY o.due_date ASC, o.id ASC
                  ) AS items,
                  SUM(o.amount_due) AS total_amount,
                  MAX(o.amount_due) AS max_amount
             FROM ledger_obligations o
             JOIN ledger_counterparties cp
               ON cp.id = o.counterparty_id AND cp.owner_id = o.owner_id
            WHERE o.owner_id = p.tenant_id
              AND o.currency = p.currency
              AND o.due_date >= $1::timestamptz
              AND o.due_date <= $1::timestamptz + interval '90 days'
              AND o.status IN ('upcoming', 'due', 'overdue')
              AND (o.direction IS NULL OR o.direction = 'payable')
         ) payable ON true
     ),
     eligible AS (
       SELECT wf.*,
              row_number() OVER (
                PARTITION BY wf.tenant_id
                ORDER BY ABS(wf.current_balance::numeric) DESC, wf.currency ASC, wf.balance_id ASC
              ) AS tenant_rank,
              COUNT(*) OVER() AS eligible_count
         FROM with_flows wf
         LEFT JOIN agent_trigger_cooldowns cd
           ON cd.tenant_id = wf.tenant_id
          AND cd.agent_key = 'cash_forecast'
          AND cd.receivable_kind = 'balance'
          AND cd.receivable_id = wf.balance_id
          AND cd.aging_tier = 'forecast'
        WHERE cd.id IS NULL OR cd.last_enqueued_at < $2::timestamptz
     ),
     fair AS (
       SELECT *
         FROM eligible
        WHERE tenant_rank <= $3
     )
     SELECT tenant_id,
            currency,
            balance_id,
            current_balance,
            as_of::text AS as_of,
            receivables,
            payables,
            total_flow_amount,
            max_payable_amount,
            eligible_count,
            COUNT(*) OVER() AS fair_count
       FROM fair
      ORDER BY tenant_id ASC, currency ASC, balance_id ASC
      LIMIT $4`,
    [now.toISOString(), cutoff.toISOString(), perTenantLimit, limit],
  );
  const totalEligible = normalizeCount(rows[0]?.eligible_count, rows.length);
  const totalFair = normalizeCount(rows[0]?.fair_count, rows.length);
  return {
    rows: rows.map((row) => ({
      ...row,
      receivables: normalizeFlows(row.receivables, "receivable"),
      payables: normalizeFlows(row.payables, "payable"),
    })),
    totalEligible,
    totalFair,
  };
}

async function claimCooldown(
  pool: Pool,
  row: CashForecastPositionRow,
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
         $1, current_setting('app.tenant_id', true), 'cash_forecast', $2, 'balance', $3,
         $4, $5::timestamptz, 'claimed'
       )
       ON CONFLICT (tenant_id, trigger_key) DO UPDATE SET
         last_enqueued_at = EXCLUDED.last_enqueued_at,
         last_status = 'claimed',
         updated_at = now()
       WHERE agent_trigger_cooldowns.last_enqueued_at < $6::timestamptz
       RETURNING trigger_key`,
      [triggerKey, event, row.balance_id, COOLDOWN_TIER, now.toISOString(), cutoff.toISOString()],
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

function eventFor(row: CashForecastPositionRow, opts: CashForecastScannerOptions): DomainEvent {
  const largePayable = opts.largePayableAmount ?? DEFAULT_LARGE_PAYABLE_AMOUNT;
  if (numberOrZero(row.max_payable_amount) >= largePayable) return "large_payable.created";
  const materialMin = opts.materialChangeMinAmount ?? DEFAULT_MATERIAL_CHANGE_MIN_AMOUNT;
  const materialRatio = opts.materialChangeRatio ?? DEFAULT_MATERIAL_CHANGE_RATIO;
  const currentBalance = Math.max(numberOrZero(row.current_balance), 1);
  const flowAmount = numberOrZero(row.total_flow_amount);
  if (flowAmount >= materialMin || flowAmount / currentBalance >= materialRatio) {
    return "cashflow.material_change";
  }
  return "forecast.requested";
}

function triggerKeyFor(row: CashForecastPositionRow, event: DomainEvent): string {
  return `cash_forecast:${event}:balance:${row.balance_id}:${COOLDOWN_TIER}`;
}

function normalizeFlows(raw: unknown, kind: CashFlowKind): CashForecastFlowContext[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => normalizeFlow(item, kind))
    .filter((row): row is CashForecastFlowContext => row !== null);
}

type CashFlowKind = "receivable" | "payable";

function normalizeFlow(raw: unknown, kind: CashFlowKind): CashForecastFlowContext | null {
  if (typeof raw !== "object" || raw === null) return null;
  const row = raw as Record<string, unknown>;
  const amount = stringOrNull(row.amount);
  const currency = stringOrNull(row.currency);
  const dueDate = stringOrNull(row.due_date);
  if (amount === null || currency === null || dueDate === null) return null;
  const id = kind === "receivable" ? stringOrNull(row.invoice_id) : stringOrNull(row.obligation_id);
  if (id === null) return null;
  return {
    ...(kind === "receivable" ? { invoice_id: id } : { obligation_id: id }),
    amount,
    currency,
    due_date: dueDate,
    counterparty_id: stringOrNull(row.counterparty_id),
    counterparty_name: stringOrNull(row.counterparty_name),
  };
}

function normalizeCount(value: number | string | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrZero(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
