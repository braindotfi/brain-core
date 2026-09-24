import type { Pool } from "pg";
import {
  NoneDirectoryProvider,
  startManagedInterval,
  withTenantScope,
  type DirectoryProvider,
  type DirectorySubscriptionUsage,
  type DomainEvent,
  type ManagedWorker,
  type MetricsEmitter,
  type ServiceCallContext,
} from "@brain/shared";
import type { AgentRunService } from "@brain/agent-router";

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_PER_TENANT_BATCH_SIZE = 25;
const DEFAULT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const DEFAULT_UNDERUTILIZATION_THRESHOLD = 0.6;
const SCANNER_ACTOR = "subscription_management_scanner";
const COOLDOWN_TIER = "subscription_management";

export interface SubscriptionManagementRow {
  readonly tenant_id: string;
  readonly subscription_id: string;
  readonly transaction_id: string;
  readonly counterparty_id: string;
  readonly merchant: string;
  readonly amount: string;
  readonly currency: string;
  readonly transaction_date: string;
  readonly current_plan: string | null;
  readonly renewal_date: string | null;
  readonly category: string | null;
}

export interface SubscriptionManagementScannerDeps {
  readonly scanPool: Pool;
  readonly appPool: Pool;
  readonly runService: Pick<AgentRunService, "run">;
  readonly directoryProvider?: DirectoryProvider;
  readonly metrics?: MetricsEmitter;
  readonly log?: {
    error(obj: unknown, msg?: string): void;
    warn(obj: unknown, msg?: string): void;
  };
}

export interface SubscriptionManagementScannerOptions {
  readonly intervalMs?: number;
  readonly batchSize?: number;
  readonly perTenantBatchSize?: number;
  readonly cooldownMs?: number;
  readonly underutilizationThreshold?: number;
  readonly now?: Date;
}

interface SubscriptionManagementSelection {
  readonly rows: SubscriptionManagementRow[];
  readonly totalEligible: number;
  readonly totalFair: number;
}

interface SubscriptionManagementDbRow extends SubscriptionManagementRow {
  readonly eligible_count?: number | string;
  readonly fair_count?: number | string;
}

export function startSubscriptionManagementScanner(
  deps: SubscriptionManagementScannerDeps,
  opts: SubscriptionManagementScannerOptions = {},
): ManagedWorker {
  return startManagedInterval(
    () => runSubscriptionManagementScanCycle(deps, opts),
    opts.intervalMs ?? DEFAULT_INTERVAL_MS,
    {
      name: "subscription-management-scanner",
      runImmediately: false,
      onError: (err) => deps.log?.error({ err }, "subscription management scanner failed"),
    },
  );
}

export async function runSubscriptionManagementScanCycle(
  deps: SubscriptionManagementScannerDeps,
  opts: SubscriptionManagementScannerOptions = {},
): Promise<void> {
  const now = opts.now ?? new Date();
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const perTenantBatchSize = opts.perTenantBatchSize ?? DEFAULT_PER_TENANT_BATCH_SIZE;
  const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const threshold = opts.underutilizationThreshold ?? DEFAULT_UNDERUTILIZATION_THRESHOLD;
  const directoryProvider = deps.directoryProvider ?? new NoneDirectoryProvider();
  const selection = await listSubscriptionManagementRows(
    deps.scanPool,
    now,
    batchSize + 1,
    perTenantBatchSize,
    cooldownMs,
  );
  const rows = selection.rows.slice(0, batchSize);
  if (selection.totalFair > batchSize) {
    const omittedCount = Math.max(selection.totalEligible - batchSize, 0);
    deps.log?.warn(
      { batchSize, perTenantBatchSize, omitted_count: omittedCount },
      "subscription management scanner hit batch cap",
    );
    deps.metrics?.increment(
      "brain.subscription_management.scan.dropped.count",
      { reason: "batch_cap" },
      omittedCount,
    );
  }

  const usageByTenant = new Map<string, readonly DirectorySubscriptionUsage[]>();
  const perTenant = new Map<string, number>();
  for (const row of rows) {
    const usageRows =
      usageByTenant.get(row.tenant_id) ??
      (await directoryProvider.listSubscriptionUsage(row.tenant_id, now));
    usageByTenant.set(row.tenant_id, usageRows);
    const usage = usageFor(row, usageRows);
    if (usage === null) continue;
    if (usage.licensed <= 0) continue;
    const activeRatio = usage.active_30d / usage.licensed;
    if (activeRatio >= threshold) continue;

    const event: DomainEvent = "subscription.seats_underutilized";
    const triggerKey = triggerKeyFor(row, event);
    const claimed = await claimCooldown(deps.appPool, row, event, triggerKey, now, cooldownMs);
    if (!claimed) continue;

    perTenant.set(row.tenant_id, (perTenant.get(row.tenant_id) ?? 0) + 1);
    const targetSeats = Math.max(usage.active_30d, 1);
    const context = contextFor(row, usage, targetSeats, "unsupported");

    let status = "failed";
    let runId: string | null = null;
    let proposalId: string | null = null;
    try {
      const result = await deps.runService.run(ctxFor(row.tenant_id), {
        tenant_id: row.tenant_id,
        event,
        context,
      });
      status = result.status;
      runId = result.run_id;
      proposalId = result.proposed?.id ?? null;
    } catch (err) {
      deps.log?.error({ err, tenantId: row.tenant_id, subscriptionId: row.subscription_id });
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
    deps.metrics?.increment(
      "brain.subscription_management.scan.count",
      { tenant_id: tenantId },
      count,
    );
    deps.metrics?.gauge("brain.subscription_management.scan.last_success_unixtime", successUnix, {
      tenant_id: tenantId,
    });
  }
}

async function listSubscriptionManagementRows(
  pool: Pool,
  now: Date,
  limit: number,
  perTenantLimit: number,
  cooldownMs: number,
): Promise<SubscriptionManagementSelection> {
  const cutoff = new Date(now.getTime() - cooldownMs);
  const { rows } = await pool.query<SubscriptionManagementDbRow>(
    `WITH latest AS (
       SELECT tx.*,
              cp.name AS merchant,
              cp.metadata #>> '{subscription,current_plan}' AS current_plan,
              cp.metadata #>> '{subscription,renewal_date}' AS renewal_date,
              COALESCE(cp.metadata #>> '{subscription,category}', cp.metadata->>'category') AS category,
              row_number() OVER (
                PARTITION BY tx.owner_id, tx.counterparty_id
                ORDER BY tx.transaction_date DESC, tx.id DESC
              ) AS cp_rank
         FROM ledger_transactions tx
         JOIN ledger_counterparties cp
           ON cp.id = tx.counterparty_id AND cp.owner_id = tx.owner_id
        WHERE tx.direction = 'outflow'
          AND tx.counterparty_id IS NOT NULL
          AND tx.status IN ('posted', 'cleared')
     ),
     candidates AS (
       SELECT l.owner_id AS tenant_id,
              l.counterparty_id AS subscription_id,
              l.id AS transaction_id,
              l.counterparty_id,
              l.merchant,
              l.amount::text AS amount,
              l.currency,
              l.transaction_date::text AS transaction_date,
              l.current_plan,
              l.renewal_date,
              l.category
         FROM latest l
         JOIN LATERAL (
           SELECT COUNT(*) AS history_count
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
              row_number() OVER (
                PARTITION BY c.tenant_id
                ORDER BY c.transaction_date DESC, c.transaction_id ASC
              ) AS tenant_rank,
              COUNT(*) OVER() AS eligible_count
         FROM candidates c
         LEFT JOIN agent_trigger_cooldowns cd
           ON cd.tenant_id = c.tenant_id
          AND cd.agent_key = 'subscription_management'
          AND cd.receivable_kind = 'subscription'
          AND cd.receivable_id = c.subscription_id
          AND cd.aging_tier = 'subscription_management'
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
    rows,
    totalEligible: normalizeCount(rows[0]?.eligible_count, rows.length),
    totalFair: normalizeCount(rows[0]?.fair_count, rows.length),
  };
}

async function claimCooldown(
  pool: Pool,
  row: SubscriptionManagementRow,
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
       VALUES ($1, current_setting('app.tenant_id', true), 'subscription_management', $2,
         'subscription', $3, $4, $5::timestamptz, 'claimed')
       ON CONFLICT (tenant_id, trigger_key) DO UPDATE SET
         last_enqueued_at = EXCLUDED.last_enqueued_at,
         last_status = 'claimed',
         updated_at = now()
       WHERE agent_trigger_cooldowns.last_enqueued_at < $6::timestamptz
       RETURNING trigger_key`,
      [
        triggerKey,
        event,
        row.subscription_id,
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

function usageFor(
  row: SubscriptionManagementRow,
  usageRows: readonly DirectorySubscriptionUsage[],
): DirectorySubscriptionUsage | null {
  return (
    usageRows.find((usage) => usage.subscription_id === row.subscription_id) ??
    usageRows.find((usage) => usage.merchant === row.merchant) ??
    null
  );
}

function contextFor(
  row: SubscriptionManagementRow,
  usage: DirectorySubscriptionUsage,
  targetSeats: number,
  vendorApiStatus: string,
): Record<string, unknown> {
  const currentPrice = Number(row.amount);
  const seatPrice = usage.licensed > 0 ? currentPrice / usage.licensed : 0;
  const targetPrice = seatPrice * targetSeats;
  const savings = Math.max(0, currentPrice - targetPrice);
  return {
    subscription_id: row.subscription_id,
    transaction_id: row.transaction_id,
    counterparty_id: row.counterparty_id,
    merchant: row.merchant,
    current_plan: row.current_plan ?? "current",
    renewal_date: row.renewal_date,
    currency: row.currency,
    current_price: row.amount,
    target_seats: targetSeats,
    vendor_api_status: vendorApiStatus,
    decision_context: decisionContextFor(row),
    ...definedContext({
      alternatives: alternativesFor(row.category),
    }),
    seats: {
      licensed: usage.licensed,
      active_30d: usage.active_30d,
      active_users: usage.active_users,
    },
    underutilization: {
      percent: Number((100 - (usage.active_30d / usage.licensed) * 100).toFixed(2)),
      dollar_value: savings.toFixed(2),
    },
    options: [
      {
        label: "downgrade",
        price: targetPrice.toFixed(2),
        seats: targetSeats,
        savings_vs_current: savings.toFixed(2),
        recommended: true,
      },
      {
        label: "renegotiate",
        price: row.amount,
        seats: usage.licensed,
        savings_vs_current: "0.00",
        recommended: false,
      },
      {
        label: "cancel",
        price: "0.00",
        seats: 0,
        savings_vs_current: row.amount,
        recommended: false,
      },
      {
        label: "renew",
        price: row.amount,
        seats: usage.licensed,
        savings_vs_current: "0.00",
        recommended: false,
      },
    ],
  };
}

const SAAS_ALTERNATIVES: Readonly<Record<string, readonly Record<string, string>[]>> = {
  crm: [
    { name: "HubSpot Starter", note: "Lower cost CRM bundle", price: "From 20 per seat monthly" },
    { name: "Pipedrive", note: "Sales pipeline focused", price: "From 14 per seat monthly" },
  ],
  identity: [
    {
      name: "Google Workspace SSO",
      note: "Use bundled identity controls",
      price: "Included in eligible plans",
    },
    {
      name: "Microsoft Entra ID P1",
      note: "Directory and access management",
      price: "From 6 per user monthly",
    },
  ],
  productivity: [
    {
      name: "Google Workspace Business",
      note: "Shared productivity suite",
      price: "From 12 per user monthly",
    },
    {
      name: "Microsoft 365 Business",
      note: "Productivity and email suite",
      price: "From 12.50 per user monthly",
    },
  ],
  support: [
    { name: "Help Scout", note: "Shared inbox support", price: "From 20 per user monthly" },
    { name: "Freshdesk", note: "Ticketing for support teams", price: "From 15 per agent monthly" },
  ],
};

function alternativesFor(category: string | null): readonly Record<string, string>[] | undefined {
  if (category === null) return undefined;
  return SAAS_ALTERNATIVES[category.toLowerCase()];
}

function decisionContextFor(row: SubscriptionManagementRow): Record<string, unknown> {
  const renewal = row.renewal_date ?? row.transaction_date;
  return {
    decide_by: `Before renewal ${renewal}`,
    if_wrong:
      "Cutting seats too far can disrupt active users. Keeping unused seats can leave avoidable spend in place.",
    reversible: {
      state: "yes",
      label: "Yes before vendor change is submitted",
    },
  };
}

function triggerKeyFor(row: SubscriptionManagementRow, event: DomainEvent): string {
  return `subscription_management:${event}:subscription:${row.subscription_id}:${COOLDOWN_TIER}`;
}

function normalizeCount(value: number | string | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function definedContext(input: Record<string, unknown | undefined>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}
