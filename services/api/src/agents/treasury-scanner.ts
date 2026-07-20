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
const DEFAULT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const DEFAULT_OPERATING_MINIMUM = 50_000;
const DEFAULT_LOW_BALANCE_FLOOR = 25_000;
const DEFAULT_SURPLUS_FLOOR = 100_000;
const SCANNER_ACTOR = "treasury_scanner";

export interface TreasuryBalanceRow {
  readonly tenant_id: string;
  readonly balance_id: string;
  readonly account_id: string;
  readonly current_balance: string;
  readonly currency: string;
  readonly as_of: string;
  readonly event_hint: string;
}

export interface TreasuryScannerDeps {
  readonly scanPool: Pool;
  readonly appPool: Pool;
  readonly runService: Pick<AgentRunService, "run">;
  readonly metrics?: MetricsEmitter;
  readonly log?: {
    error(obj: unknown, msg?: string): void;
    warn(obj: unknown, msg?: string): void;
  };
}

export interface TreasuryScannerOptions {
  readonly intervalMs?: number;
  readonly batchSize?: number;
  readonly perTenantBatchSize?: number;
  readonly cooldownMs?: number;
  readonly operatingMinimum?: number;
  readonly lowBalanceFloor?: number;
  readonly surplusFloor?: number;
  readonly now?: Date;
}

interface TreasurySelection {
  readonly rows: TreasuryBalanceRow[];
  readonly totalEligible: number;
  readonly totalFair: number;
}

interface TreasuryDbRow extends TreasuryBalanceRow {
  readonly eligible_count?: number | string;
  readonly fair_count?: number | string;
}

export function startTreasuryScanner(
  deps: TreasuryScannerDeps,
  opts: TreasuryScannerOptions = {},
): ManagedWorker {
  return startManagedInterval(
    () => runTreasuryScanCycle(deps, opts),
    opts.intervalMs ?? DEFAULT_INTERVAL_MS,
    {
      name: "treasury-scanner",
      runImmediately: false,
      onError: (err) => deps.log?.error({ err }, "treasury scanner failed"),
    },
  );
}

export async function runTreasuryScanCycle(
  deps: TreasuryScannerDeps,
  opts: TreasuryScannerOptions = {},
): Promise<void> {
  const now = opts.now ?? new Date();
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const perTenantBatchSize = opts.perTenantBatchSize ?? DEFAULT_PER_TENANT_BATCH_SIZE;
  const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const thresholds = thresholdsFor(opts);
  const selection = await listTreasuryBalances(
    deps.scanPool,
    now,
    batchSize + 1,
    perTenantBatchSize,
    cooldownMs,
    thresholds,
  );
  const rows = selection.rows.slice(0, batchSize);
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
      "treasury scanner hit batch cap",
    );
    deps.metrics?.increment(
      "brain.treasury.scan.dropped.count",
      { reason: "batch_cap" },
      omittedCount,
    );
  }

  const perTenant = new Map<string, number>();
  for (const row of rows) {
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
          balance_id: row.balance_id,
          account_id: row.account_id,
          source_account_id: row.account_id,
          current_balance: row.current_balance,
          currency: row.currency,
          as_of: row.as_of,
          thresholds: {
            operating_minimum: thresholds.operatingMinimum.toFixed(2),
            low_balance_floor: thresholds.lowBalanceFloor.toFixed(2),
            surplus_floor: thresholds.surplusFloor.toFixed(2),
          },
        },
      });
      status = result.status;
      runId = result.run_id;
      proposalId = result.proposed?.id ?? null;
    } catch (err) {
      deps.log?.error(
        { err, tenantId: row.tenant_id, balanceId: row.balance_id },
        "treasury run failed",
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
    deps.metrics?.increment("brain.treasury.scan.count", { tenant_id: tenantId }, count);
    deps.metrics?.gauge("brain.treasury.scan.last_success_unixtime", successUnix, {
      tenant_id: tenantId,
    });
  }
}

async function listTreasuryBalances(
  pool: Pool,
  now: Date,
  limit: number,
  perTenantLimit: number,
  cooldownMs: number,
  thresholds: Thresholds,
): Promise<TreasurySelection> {
  const cutoff = new Date(now.getTime() - cooldownMs);
  const { rows } = await pool.query<TreasuryDbRow>(
    `WITH latest AS (
       SELECT *
         FROM (
           SELECT b.owner_id AS tenant_id,
                  b.id AS balance_id,
                  b.account_id,
                  b.current_balance::text AS current_balance,
                  b.currency,
                  b.as_of::text AS as_of,
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
     candidates AS (
       SELECT l.*,
              CASE
                WHEN l.current_balance::numeric <= $4::numeric THEN 'cash.balance_low'
                WHEN l.current_balance::numeric >= $5::numeric THEN 'cash.balance_high'
                ELSE 'runway.changed'
              END AS event_hint
         FROM latest l
        WHERE l.current_balance::numeric <= $4::numeric
           OR l.current_balance::numeric >= $5::numeric
     ),
     eligible AS (
       SELECT c.*,
              row_number() OVER (
                PARTITION BY c.tenant_id
                ORDER BY ABS(c.current_balance::numeric) DESC, c.balance_id ASC
              ) AS tenant_rank,
              COUNT(*) OVER() AS eligible_count
         FROM candidates c
         LEFT JOIN agent_trigger_cooldowns cd
           ON cd.tenant_id = c.tenant_id
          AND cd.agent_key = 'treasury'
          AND cd.receivable_kind = 'balance'
          AND cd.receivable_id = c.balance_id
          AND cd.aging_tier = c.event_hint
        WHERE cd.id IS NULL OR cd.last_enqueued_at < $1::timestamptz
     ),
     fair AS (
       SELECT * FROM eligible WHERE tenant_rank <= $2
     )
     SELECT *, COUNT(*) OVER() AS fair_count
       FROM fair
      ORDER BY tenant_id ASC, event_hint ASC, balance_id ASC
      LIMIT $3`,
    [
      cutoff.toISOString(),
      perTenantLimit,
      limit,
      thresholds.lowBalanceFloor.toFixed(2),
      thresholds.surplusFloor.toFixed(2),
    ],
  );
  return {
    rows,
    totalEligible: normalizeCount(rows[0]?.eligible_count, rows.length),
    totalFair: normalizeCount(rows[0]?.fair_count, rows.length),
  };
}

async function claimCooldown(
  pool: Pool,
  row: TreasuryBalanceRow,
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
         $1, current_setting('app.tenant_id', true), 'treasury', $2, 'balance', $3,
         $4, $5::timestamptz, 'claimed'
       )
       ON CONFLICT (tenant_id, trigger_key) DO UPDATE SET
         last_enqueued_at = EXCLUDED.last_enqueued_at,
         last_status = 'claimed',
         updated_at = now()
       WHERE agent_trigger_cooldowns.last_enqueued_at < $6::timestamptz
       RETURNING trigger_key`,
      [triggerKey, event, row.balance_id, event, now.toISOString(), cutoff.toISOString()],
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

interface Thresholds {
  readonly operatingMinimum: number;
  readonly lowBalanceFloor: number;
  readonly surplusFloor: number;
}

function thresholdsFor(opts: TreasuryScannerOptions): Thresholds {
  const operatingMinimum = opts.operatingMinimum ?? DEFAULT_OPERATING_MINIMUM;
  return {
    operatingMinimum,
    lowBalanceFloor: opts.lowBalanceFloor ?? DEFAULT_LOW_BALANCE_FLOOR,
    surplusFloor: opts.surplusFloor ?? DEFAULT_SURPLUS_FLOOR,
  };
}

function ctxFor(tenantId: string): ServiceCallContext {
  return {
    tenantId,
    actor: SCANNER_ACTOR,
    principalType: "api_partner",
    scopes: ["execution:propose"],
  };
}

function eventFor(row: TreasuryBalanceRow): DomainEvent {
  return row.event_hint === "cash.balance_low" ? "cash.balance_low" : "cash.balance_high";
}

function triggerKeyFor(row: TreasuryBalanceRow, event: DomainEvent): string {
  return `treasury:${event}:balance:${row.balance_id}`;
}

function normalizeCount(value: number | string | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}
