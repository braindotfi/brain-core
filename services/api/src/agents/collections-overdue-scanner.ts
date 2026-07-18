import type { Pool } from "pg";
import {
  startManagedInterval,
  withTenantScope,
  type ManagedWorker,
  type MetricsEmitter,
  type ServiceCallContext,
} from "@brain/shared";
import type { AgentRunService } from "@brain/agent-router";
import type { DomainEvent } from "@brain/shared";

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const SCANNER_ACTOR = "collections_overdue_scanner";

export interface CollectionsOverdueReceivableRow {
  tenant_id: string;
  id: string;
  invoice_number: string;
  counterparty_id: string;
  counterparty_name: string;
  amount: string;
  currency: string;
  due_date: string;
  days_overdue: number;
  aging_tier: string;
}

export interface CollectionsOverdueScannerDeps {
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

export interface CollectionsOverdueScannerOptions {
  readonly intervalMs?: number;
  readonly batchSize?: number;
  readonly cooldownMs?: number;
  readonly now?: Date;
}

export function startCollectionsOverdueScanner(
  deps: CollectionsOverdueScannerDeps,
  opts: CollectionsOverdueScannerOptions = {},
): ManagedWorker {
  return startManagedInterval(
    () => runCollectionsOverdueScanCycle(deps, opts),
    opts.intervalMs ?? DEFAULT_INTERVAL_MS,
    {
      name: "collections-overdue-scanner",
      runImmediately: false,
      onError: (err) => deps.log?.error({ err }, "collections overdue scanner failed"),
    },
  );
}

export async function runCollectionsOverdueScanCycle(
  deps: CollectionsOverdueScannerDeps,
  opts: CollectionsOverdueScannerOptions = {},
): Promise<void> {
  const now = opts.now ?? new Date();
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const rows = await listOverdueReceivables(deps.scanPool, now, batchSize + 1);
  const capped = rows.length > batchSize;
  const receivables = rows.slice(0, batchSize);
  if (capped) {
    deps.log?.warn(
      {
        batchSize,
        omitted_lower_bound: rows.length - batchSize,
      },
      "collections overdue scanner hit batch cap",
    );
    deps.metrics?.increment("brain.collections.scan.dropped.count", { reason: "batch_cap" }, 1);
  }

  const perTenant = new Map<string, number>();
  for (const row of receivables) {
    perTenant.set(row.tenant_id, (perTenant.get(row.tenant_id) ?? 0) + 1);
    const event = eventFor(row.aging_tier);
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
          invoice_id: row.id,
          invoice_number: row.invoice_number,
          counterparty_id: row.counterparty_id,
          counterparty_name: row.counterparty_name,
          amount: row.amount,
          currency: row.currency,
          due_date: row.due_date,
          days_overdue: row.days_overdue,
          aging_tier: row.aging_tier,
        },
      });
      status = result.status;
      runId = result.run_id;
      proposalId = result.proposed?.id ?? null;
    } catch (err) {
      deps.log?.error(
        { err, tenantId: row.tenant_id, receivableId: row.id },
        "collections overdue run failed",
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
    deps.metrics?.increment("brain.collections.scan.count", { tenant_id: tenantId }, count);
    deps.metrics?.gauge("brain.collections.scan.last_success_unixtime", successUnix, {
      tenant_id: tenantId,
    });
  }
}

async function listOverdueReceivables(
  pool: Pool,
  now: Date,
  limit: number,
): Promise<CollectionsOverdueReceivableRow[]> {
  const { rows } = await pool.query<CollectionsOverdueReceivableRow>(
    `SELECT i.owner_id AS tenant_id,
            i.id,
            i.invoice_number,
            i.counterparty_id,
            cp.name AS counterparty_name,
            (i.amount_due - i.amount_paid)::text AS amount,
            i.currency,
            i.due_date::text AS due_date,
            GREATEST(FLOOR(EXTRACT(EPOCH FROM ($1::timestamptz - i.due_date)) / 86400), 1)::int
              AS days_overdue,
            CASE
              WHEN GREATEST(FLOOR(EXTRACT(EPOCH FROM ($1::timestamptz - i.due_date)) / 86400), 1) >= 90 THEN '90_plus'
              WHEN GREATEST(FLOOR(EXTRACT(EPOCH FROM ($1::timestamptz - i.due_date)) / 86400), 1) >= 60 THEN '60_89'
              WHEN GREATEST(FLOOR(EXTRACT(EPOCH FROM ($1::timestamptz - i.due_date)) / 86400), 1) >= 30 THEN '30_59'
              WHEN GREATEST(FLOOR(EXTRACT(EPOCH FROM ($1::timestamptz - i.due_date)) / 86400), 1) >= 15 THEN '15_29'
              ELSE '1_14'
            END AS aging_tier
       FROM ledger_invoices i
       JOIN ledger_counterparties cp ON cp.id = i.counterparty_id AND cp.owner_id = i.owner_id
      WHERE i.due_date IS NOT NULL
        AND i.due_date < $1::timestamptz
        AND i.amount_paid < i.amount_due
        AND i.status NOT IN ('paid', 'cancelled', 'disputed')
      ORDER BY i.due_date ASC, i.id ASC
      LIMIT $2`,
    [now.toISOString(), limit],
  );
  return rows;
}

async function claimCooldown(
  pool: Pool,
  row: CollectionsOverdueReceivableRow,
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
         $1, current_setting('app.tenant_id', true), 'collections', $2, 'invoice', $3,
         $4, $5::timestamptz, 'claimed'
       )
       ON CONFLICT (tenant_id, trigger_key) DO UPDATE SET
         last_enqueued_at = EXCLUDED.last_enqueued_at,
         last_status = 'claimed',
         updated_at = now()
       WHERE agent_trigger_cooldowns.last_enqueued_at < $6::timestamptz
       RETURNING trigger_key`,
      [triggerKey, event, row.id, row.aging_tier, now.toISOString(), cutoff.toISOString()],
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

function eventFor(agingTier: string): DomainEvent {
  return agingTier === "1_14" ? "invoice.overdue" : "receivable.aging_threshold_crossed";
}

function triggerKeyFor(row: CollectionsOverdueReceivableRow, event: DomainEvent): string {
  return `collections:${event}:invoice:${row.id}:aging:${row.aging_tier}`;
}
