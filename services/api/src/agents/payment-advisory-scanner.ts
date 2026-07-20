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
const DEFAULT_DUE_SOON_DAYS = 14;
const DEFAULT_DISCOUNT_DAYS = 7;
const SCANNER_ACTOR = "payment_advisory_scanner";
const COOLDOWN_TIER = "payment_advisory";

export interface PaymentAdvisoryRow {
  readonly tenant_id: string;
  readonly obligation_id: string;
  readonly counterparty_id: string;
  readonly counterparty_name: string;
  readonly payment_destination_id: string | null;
  readonly source_account_id: string | null;
  readonly amount: string;
  readonly currency: string;
  readonly due_date: string;
  readonly available_cash: string | null;
  readonly discount_expires_at: string | null;
  readonly discount_amount: string | null;
  readonly event_hint: string;
}

export interface PaymentAdvisoryScannerDeps {
  readonly scanPool: Pool;
  readonly appPool: Pool;
  readonly runService: Pick<AgentRunService, "run">;
  readonly metrics?: MetricsEmitter;
  readonly log?: {
    error(obj: unknown, msg?: string): void;
    warn(obj: unknown, msg?: string): void;
  };
}

export interface PaymentAdvisoryScannerOptions {
  readonly intervalMs?: number;
  readonly batchSize?: number;
  readonly perTenantBatchSize?: number;
  readonly cooldownMs?: number;
  readonly dueSoonDays?: number;
  readonly discountDays?: number;
  readonly now?: Date;
}

interface PaymentAdvisorySelection {
  readonly rows: PaymentAdvisoryRow[];
  readonly totalEligible: number;
  readonly totalFair: number;
}

interface PaymentAdvisoryDbRow extends PaymentAdvisoryRow {
  readonly eligible_count?: number | string;
  readonly fair_count?: number | string;
}

export function startPaymentAdvisoryScanner(
  deps: PaymentAdvisoryScannerDeps,
  opts: PaymentAdvisoryScannerOptions = {},
): ManagedWorker {
  return startManagedInterval(
    () => runPaymentAdvisoryScanCycle(deps, opts),
    opts.intervalMs ?? DEFAULT_INTERVAL_MS,
    {
      name: "payment-advisory-scanner",
      runImmediately: false,
      onError: (err) => deps.log?.error({ err }, "payment advisory scanner failed"),
    },
  );
}

export async function runPaymentAdvisoryScanCycle(
  deps: PaymentAdvisoryScannerDeps,
  opts: PaymentAdvisoryScannerOptions = {},
): Promise<void> {
  const now = opts.now ?? new Date();
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const perTenantBatchSize = opts.perTenantBatchSize ?? DEFAULT_PER_TENANT_BATCH_SIZE;
  const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const selection = await listPaymentAdvisories(
    deps.scanPool,
    now,
    batchSize + 1,
    perTenantBatchSize,
    cooldownMs,
    opts.dueSoonDays ?? DEFAULT_DUE_SOON_DAYS,
    opts.discountDays ?? DEFAULT_DISCOUNT_DAYS,
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
      "payment advisory scanner hit batch cap",
    );
    deps.metrics?.increment(
      "brain.payment.scan.dropped.count",
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
          obligation_id: row.obligation_id,
          counterparty_id: row.counterparty_id,
          counterparty_name: row.counterparty_name,
          destination_counterparty_id: row.counterparty_id,
          payment_destination_id: row.payment_destination_id,
          payment_instruction_id: row.payment_destination_id,
          source_account_id: row.source_account_id,
          amount: row.amount,
          currency: row.currency,
          due_date: row.due_date,
          available_cash: row.available_cash,
          discount_expires_at: row.discount_expires_at,
          discount_amount: row.discount_amount,
          payables: [
            {
              obligation_id: row.obligation_id,
              counterparty_id: row.counterparty_id,
              counterparty_name: row.counterparty_name,
              amount: row.amount,
              currency: row.currency,
              due_date: row.due_date,
              discount_expires_at: row.discount_expires_at,
              discount_amount: row.discount_amount,
            },
          ],
        },
      });
      status = result.status;
      runId = result.run_id;
      proposalId = result.proposed?.id ?? null;
    } catch (err) {
      deps.log?.error(
        { err, tenantId: row.tenant_id, obligationId: row.obligation_id },
        "payment advisory run failed",
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
    deps.metrics?.increment("brain.payment.scan.count", { tenant_id: tenantId }, count);
    deps.metrics?.gauge("brain.payment.scan.last_success_unixtime", successUnix, {
      tenant_id: tenantId,
    });
  }
}

async function listPaymentAdvisories(
  pool: Pool,
  now: Date,
  limit: number,
  perTenantLimit: number,
  cooldownMs: number,
  dueSoonDays: number,
  discountDays: number,
): Promise<PaymentAdvisorySelection> {
  const cutoff = new Date(now.getTime() - cooldownMs);
  const { rows } = await pool.query<PaymentAdvisoryDbRow>(
    `WITH candidates AS (
       SELECT o.owner_id AS tenant_id,
              o.id AS obligation_id,
              o.counterparty_id,
              cp.name AS counterparty_name,
              cpi.id AS payment_destination_id,
              acct.id AS source_account_id,
              o.amount_due::text AS amount,
              o.currency,
              o.due_date::text AS due_date,
              bal.current_balance::text AS available_cash,
              o.metadata->>'discount_expires_at' AS discount_expires_at,
              COALESCE(o.metadata->>'discount_amount', o.metadata->>'early_payment_discount_amount')
                AS discount_amount,
              CASE
                WHEN o.metadata->>'discount_expires_at' IS NOT NULL
                 AND (o.metadata->>'discount_expires_at')::timestamptz <= $1::timestamptz + ($6::int * interval '1 day')
                  THEN 'payable.discount_expiring'
                ELSE 'payable.due_soon'
              END AS event_hint
         FROM ledger_obligations o
         JOIN ledger_counterparties cp
           ON cp.id = o.counterparty_id AND cp.owner_id = o.owner_id
         LEFT JOIN LATERAL (
           SELECT p.id
             FROM ledger_counterparty_payment_instructions p
            WHERE p.owner_id = o.owner_id
              AND p.counterparty_id = o.counterparty_id
            ORDER BY p.changed_at DESC, p.id ASC
            LIMIT 1
         ) cpi ON true
         JOIN LATERAL (
           SELECT a.id
             FROM ledger_accounts a
            WHERE a.owner_id = o.owner_id
              AND a.currency = o.currency
              AND a.status = 'active'
              AND a.account_type IN ('bank_checking', 'bank_savings')
            ORDER BY a.created_at ASC, a.id ASC
            LIMIT 1
         ) acct ON true
         LEFT JOIN LATERAL (
           SELECT b.current_balance
             FROM ledger_balances b
            WHERE b.owner_id = o.owner_id
              AND b.currency = o.currency
            ORDER BY b.as_of DESC, b.id ASC
            LIMIT 1
         ) bal ON true
        WHERE o.status IN ('upcoming', 'due', 'overdue')
          AND (o.direction IS NULL OR o.direction = 'payable')
          AND (
            o.due_date <= $1::timestamptz + ($5::int * interval '1 day')
            OR (
              o.metadata->>'discount_expires_at' IS NOT NULL
              AND (o.metadata->>'discount_expires_at')::timestamptz <= $1::timestamptz + ($6::int * interval '1 day')
            )
          )
     ),
     eligible AS (
       SELECT c.*,
              row_number() OVER (
                PARTITION BY c.tenant_id
                ORDER BY c.due_date ASC, c.obligation_id ASC
              ) AS tenant_rank,
              COUNT(*) OVER() AS eligible_count
         FROM candidates c
         LEFT JOIN agent_trigger_cooldowns cd
           ON cd.tenant_id = c.tenant_id
          AND cd.agent_key = 'payment'
          AND cd.receivable_kind = 'obligation'
          AND cd.receivable_id = c.obligation_id
          AND cd.aging_tier = 'payment_advisory'
        WHERE cd.id IS NULL OR cd.last_enqueued_at < $2::timestamptz
     ),
     fair AS (
       SELECT * FROM eligible WHERE tenant_rank <= $3
     )
     SELECT *, COUNT(*) OVER() AS fair_count
       FROM fair
      ORDER BY due_date ASC, obligation_id ASC
      LIMIT $4`,
    [now.toISOString(), cutoff.toISOString(), perTenantLimit, limit, dueSoonDays, discountDays],
  );
  return {
    rows,
    totalEligible: normalizeCount(rows[0]?.eligible_count, rows.length),
    totalFair: normalizeCount(rows[0]?.fair_count, rows.length),
  };
}

async function claimCooldown(
  pool: Pool,
  row: PaymentAdvisoryRow,
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
         $1, current_setting('app.tenant_id', true), 'payment', $2, 'obligation', $3,
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
        row.obligation_id,
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

function eventFor(row: PaymentAdvisoryRow): DomainEvent {
  return row.event_hint === "payable.discount_expiring"
    ? "payable.discount_expiring"
    : "payable.due_soon";
}

function triggerKeyFor(row: PaymentAdvisoryRow, event: DomainEvent): string {
  return `payment:${event}:obligation:${row.obligation_id}`;
}

function normalizeCount(value: number | string | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}
