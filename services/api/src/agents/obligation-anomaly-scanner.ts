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
const SCANNER_ACTOR = "obligation_anomaly_scanner";
const COOLDOWN_TIER = "invoice_integrity";

// Hardcoded detection constants, matching the existing precedent (fraud-anomaly-scanner's
// ratio/z-score bands are literals, not env-configurable - only interval/batch/cooldown are).
const STRUCTURING_PIECE_THRESHOLD = 10_000;
const NEW_VENDOR_HIGH_VALUE_FLOOR = 10_000;
const THRESHOLD_AVOIDANCE_BAND = 0.97; // flag amounts in [threshold*0.97, threshold)
// Real-world approval thresholds aren't only at sparse round numbers like 50k/100k -
// a tenant's actual threshold (e.g. $90,000) can fall anywhere on a $10k grid, so
// check every $10k step up to $1M rather than a handful of "nice" amounts.
const THRESHOLD_AVOIDANCE_CANDIDATES = Array.from({ length: 100 }, (_, i) => (i + 1) * 10_000);

export interface ObligationAnomalyRow {
  readonly tenant_id: string;
  readonly obligation_id: string;
  readonly counterparty_id: string | null;
  readonly counterparty_name: string | null;
  readonly counterparty_verified_status: string | null;
  readonly amount_due: string;
  readonly currency: string;
  readonly due_date: string;
  readonly duplicate_obligation_ids: readonly string[];
  readonly structuring_group_ids: readonly string[];
  readonly structuring_group_total: string | null;
  readonly threshold_amount: string | null;
  readonly event_hint: string;
}

export interface ObligationAnomalyScannerDeps {
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

export interface ObligationAnomalyScannerOptions {
  readonly intervalMs?: number;
  readonly batchSize?: number;
  readonly perTenantBatchSize?: number;
  readonly cooldownMs?: number;
  readonly now?: Date;
}

interface ObligationAnomalySelection {
  readonly rows: ObligationAnomalyRow[];
  readonly totalEligible: number;
  readonly totalFair: number;
}

interface ObligationAnomalyDbRow extends Omit<
  ObligationAnomalyRow,
  "duplicate_obligation_ids" | "structuring_group_ids"
> {
  readonly duplicate_obligation_ids: unknown;
  readonly structuring_group_ids: unknown;
  readonly eligible_count?: number | string;
  readonly fair_count?: number | string;
}

export function startObligationAnomalyScanner(
  deps: ObligationAnomalyScannerDeps,
  opts: ObligationAnomalyScannerOptions = {},
): ManagedWorker {
  return startManagedInterval(
    () => runObligationAnomalyScanCycle(deps, opts),
    opts.intervalMs ?? DEFAULT_INTERVAL_MS,
    {
      name: "obligation-anomaly-scanner",
      runImmediately: false,
      onError: (err) => deps.log?.error({ err }, "obligation anomaly scanner failed"),
    },
  );
}

export async function runObligationAnomalyScanCycle(
  deps: ObligationAnomalyScannerDeps,
  opts: ObligationAnomalyScannerOptions = {},
): Promise<void> {
  const now = opts.now ?? new Date();
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const perTenantBatchSize = opts.perTenantBatchSize ?? DEFAULT_PER_TENANT_BATCH_SIZE;
  const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const selection = await listAnomalousObligations(
    deps.scanPool,
    now,
    batchSize + 1,
    perTenantBatchSize,
    cooldownMs,
  );
  const capped = selection.totalFair > batchSize;
  const obligations = selection.rows.slice(0, batchSize);
  deps.log?.info?.(
    {
      total_eligible: selection.totalEligible,
      total_fair: selection.totalFair,
      selected_count: obligations.length,
      selected: obligations.map((row) => ({
        tenant_id: row.tenant_id,
        obligation_id: row.obligation_id,
        event_hint: row.event_hint,
      })),
    },
    "obligation anomaly scanner cycle",
  );
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
      "obligation anomaly scanner hit batch cap",
    );
    deps.metrics?.increment(
      "brain.invoice_integrity.scan.dropped.count",
      { reason: "batch_cap" },
      omittedCount,
    );
  }

  const perTenant = new Map<string, number>();
  for (const row of obligations) {
    perTenant.set(row.tenant_id, (perTenant.get(row.tenant_id) ?? 0) + 1);
    const event = eventFor(row);
    const triggerKey = triggerKeyFor(row, event);
    const claimed = await claimCooldown(deps.appPool, row, event, triggerKey, now, cooldownMs);
    if (!claimed) {
      deps.log?.info?.(
        { tenantId: row.tenant_id, obligationId: row.obligation_id, event },
        "obligation anomaly scanner skipped obligation (cooldown not claimed)",
      );
      continue;
    }

    let status = "failed";
    let runId: string | null = null;
    let proposalId: string | null = null;
    try {
      const relatedObligationIds =
        event === "obligation.structuring_suspected"
          ? row.structuring_group_ids
          : row.duplicate_obligation_ids;
      const result = await deps.runService.run(ctxFor(row.tenant_id), {
        tenant_id: row.tenant_id,
        event,
        context: {
          obligation_id: row.obligation_id,
          counterparty_id: row.counterparty_id,
          counterparty_name: row.counterparty_name,
          counterparty_verified_status: row.counterparty_verified_status,
          amount: row.amount_due,
          currency: row.currency,
          due_date: row.due_date,
          related_obligation_ids: relatedObligationIds,
          group_total_amount: row.structuring_group_total,
          threshold_amount: row.threshold_amount,
        },
      });
      status = result.status;
      runId = result.run_id;
      proposalId = result.proposed?.id ?? null;
      deps.log?.info?.(
        { tenantId: row.tenant_id, obligationId: row.obligation_id, event, status, runId, proposalId },
        "obligation anomaly scanner ran obligation",
      );
    } catch (err) {
      deps.log?.error(
        { err, tenantId: row.tenant_id, obligationId: row.obligation_id },
        "obligation anomaly run failed",
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
    deps.metrics?.increment("brain.invoice_integrity.scan.count", { tenant_id: tenantId }, count);
    deps.metrics?.gauge("brain.invoice_integrity.scan.last_success_unixtime", successUnix, {
      tenant_id: tenantId,
    });
  }
}

async function listAnomalousObligations(
  pool: Pool,
  now: Date,
  limit: number,
  perTenantLimit: number,
  cooldownMs: number,
): Promise<ObligationAnomalySelection> {
  const cutoff = new Date(now.getTime() - cooldownMs);
  const thresholdCandidates = `{${THRESHOLD_AVOIDANCE_CANDIDATES.join(",")}}`;
  const { rows } = await pool.query<ObligationAnomalyDbRow>(
    `WITH base AS (
       SELECT o.owner_id AS tenant_id,
              o.id AS obligation_id,
              o.counterparty_id,
              cp.name AS counterparty_name,
              cp.verified_status AS counterparty_verified_status,
              o.type,
              o.amount_due,
              o.currency,
              o.due_date,
              o.status
         FROM ledger_obligations o
         LEFT JOIN ledger_counterparties cp
           ON cp.id = o.counterparty_id AND cp.owner_id = o.owner_id
        WHERE o.status IN ('upcoming', 'due', 'overdue')
     ),
     enriched AS (
       SELECT b.*,
              COALESCE(dup.duplicate_count, 0) AS duplicate_count,
              COALESCE(dup.duplicate_ids, '[]'::jsonb) AS duplicate_ids,
              COALESCE(struct.group_count, 0) AS structuring_group_count,
              COALESCE(struct.group_ids, '[]'::jsonb) AS structuring_group_ids,
              struct.group_total,
              thr.threshold AS threshold_amount
         FROM base b
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS duplicate_count,
                  jsonb_agg(d.id ORDER BY d.id ASC) AS duplicate_ids
             FROM ledger_obligations d
            WHERE d.owner_id = b.tenant_id
              AND d.id <> b.obligation_id
              AND d.counterparty_id IS NOT DISTINCT FROM b.counterparty_id
              AND d.type = b.type
              AND d.amount_due = b.amount_due
              AND d.currency = b.currency
              AND d.due_date = b.due_date
              AND d.status IN ('upcoming', 'due', 'overdue')
         ) dup ON true
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS group_count,
                  jsonb_agg(g.id ORDER BY g.id ASC) AS group_ids,
                  SUM(g.amount_due) AS group_total
             FROM ledger_obligations g
            WHERE g.owner_id = b.tenant_id
              AND g.id <> b.obligation_id
              AND b.counterparty_id IS NOT NULL
              AND g.counterparty_id = b.counterparty_id
              AND g.due_date = b.due_date
              AND g.currency = b.currency
              AND g.amount_due < $4
              AND g.status IN ('upcoming', 'due', 'overdue')
         ) struct ON true
         LEFT JOIN LATERAL (
           SELECT t.threshold
             FROM unnest($5::numeric[]) AS t(threshold)
            WHERE b.amount_due < t.threshold
              AND b.amount_due >= t.threshold * $6
            ORDER BY t.threshold ASC
            LIMIT 1
         ) thr ON true
     ),
     scored AS (
       SELECT e.*,
              GREATEST(
                CASE WHEN e.duplicate_count >= 1 THEN 0.95 ELSE 0 END,
                CASE
                  WHEN e.amount_due < $4
                   AND e.structuring_group_count >= 1
                   AND (e.amount_due + COALESCE(e.group_total, 0)) >= $4
                  THEN 0.9
                  ELSE 0
                END,
                CASE WHEN e.threshold_amount IS NOT NULL THEN 0.7 ELSE 0 END,
                CASE
                  WHEN e.amount_due >= $7
                   AND (e.counterparty_id IS NULL
                        OR e.counterparty_verified_status IS NULL
                        OR e.counterparty_verified_status = 'unverified')
                  THEN 0.6
                  ELSE 0
                END
              ) AS anomaly_score
         FROM enriched e
     ),
     eligible AS (
       SELECT s.*,
              CASE
                WHEN s.duplicate_count >= 1 THEN 'obligation.duplicate_suspected'
                WHEN s.amount_due < $4
                 AND s.structuring_group_count >= 1
                 AND (s.amount_due + COALESCE(s.group_total, 0)) >= $4
                THEN 'obligation.structuring_suspected'
                WHEN s.threshold_amount IS NOT NULL THEN 'obligation.threshold_avoidance_suspected'
                ELSE 'obligation.high_value_new_vendor'
              END AS event_hint,
              row_number() OVER (
                PARTITION BY s.tenant_id
                ORDER BY s.anomaly_score DESC, s.due_date ASC, s.obligation_id ASC
              ) AS tenant_rank,
              COUNT(*) OVER() AS eligible_count
         FROM scored s
         LEFT JOIN agent_trigger_cooldowns cd
           ON cd.tenant_id = s.tenant_id
          AND cd.receivable_kind = 'obligation'
          AND cd.receivable_id = s.obligation_id
          AND cd.aging_tier = 'invoice_integrity'
        WHERE s.anomaly_score >= 0.5
          AND (cd.id IS NULL OR cd.last_enqueued_at < $1::timestamptz)
     ),
     fair AS (
       SELECT *
         FROM eligible
        WHERE tenant_rank <= $2
     )
     SELECT tenant_id,
            obligation_id,
            counterparty_id,
            counterparty_name,
            counterparty_verified_status,
            amount_due::text AS amount_due,
            currency,
            due_date::text AS due_date,
            duplicate_ids AS duplicate_obligation_ids,
            structuring_group_ids,
            group_total::text AS structuring_group_total,
            threshold_amount::text AS threshold_amount,
            event_hint,
            eligible_count,
            COUNT(*) OVER() AS fair_count
       FROM fair
      ORDER BY anomaly_score DESC, due_date ASC, obligation_id ASC
      LIMIT $3`,
    [
      cutoff.toISOString(),
      perTenantLimit,
      limit,
      STRUCTURING_PIECE_THRESHOLD,
      thresholdCandidates,
      THRESHOLD_AVOIDANCE_BAND,
      NEW_VENDOR_HIGH_VALUE_FLOOR,
    ],
  );
  const totalEligible = normalizeCount(rows[0]?.eligible_count, rows.length);
  const totalFair = normalizeCount(rows[0]?.fair_count, rows.length);
  return {
    rows: rows.map((row) => ({
      ...row,
      duplicate_obligation_ids: normalizeStringArray(row.duplicate_obligation_ids),
      structuring_group_ids: normalizeStringArray(row.structuring_group_ids),
    })),
    totalEligible,
    totalFair,
  };
}

async function claimCooldown(
  pool: Pool,
  row: ObligationAnomalyRow,
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
         $1, current_setting('app.tenant_id', true), 'invoice_integrity', $2, 'obligation', $3,
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

function eventFor(row: ObligationAnomalyRow): DomainEvent {
  if (
    row.event_hint === "obligation.duplicate_suspected" ||
    row.event_hint === "obligation.structuring_suspected" ||
    row.event_hint === "obligation.threshold_avoidance_suspected" ||
    row.event_hint === "obligation.high_value_new_vendor"
  ) {
    return row.event_hint;
  }
  return "obligation.high_value_new_vendor";
}

function triggerKeyFor(row: ObligationAnomalyRow, event: DomainEvent): string {
  return `invoice_integrity:${event}:obligation:${row.obligation_id}:${COOLDOWN_TIER}`;
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
