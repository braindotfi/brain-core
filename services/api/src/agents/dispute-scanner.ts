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
const SCANNER_ACTOR = "dispute_scanner";
const COOLDOWN_TIER = "dispute";

export interface DisputeCandidateRow {
  readonly tenant_id: string;
  readonly dispute_id: string;
  readonly transaction_id: string;
  readonly counterparty_id: string;
  readonly amount: string;
  readonly currency: string;
  readonly deadline: string;
  readonly dispute_age_days: string;
  readonly evidence_completeness: string;
  readonly event_hint: string;
}

export interface DisputeScannerDeps {
  readonly scanPool: Pool;
  readonly appPool: Pool;
  readonly runService: Pick<AgentRunService, "run">;
  readonly metrics?: MetricsEmitter;
  readonly log?: {
    error(obj: unknown, msg?: string): void;
    warn(obj: unknown, msg?: string): void;
  };
}

export interface DisputeScannerOptions {
  readonly intervalMs?: number;
  readonly batchSize?: number;
  readonly perTenantBatchSize?: number;
  readonly cooldownMs?: number;
  readonly now?: Date;
}

interface DisputeSelection {
  readonly rows: DisputeCandidateRow[];
  readonly totalEligible: number;
  readonly totalFair: number;
}

interface DisputeDbRow extends DisputeCandidateRow {
  readonly eligible_count?: number | string;
  readonly fair_count?: number | string;
}

export function startDisputeScanner(
  deps: DisputeScannerDeps,
  opts: DisputeScannerOptions = {},
): ManagedWorker {
  return startManagedInterval(
    () => runDisputeScanCycle(deps, opts),
    opts.intervalMs ?? DEFAULT_INTERVAL_MS,
    {
      name: "dispute-scanner",
      runImmediately: false,
      onError: (err) => deps.log?.error({ err }, "dispute scanner failed"),
    },
  );
}

export async function runDisputeScanCycle(
  deps: DisputeScannerDeps,
  opts: DisputeScannerOptions = {},
): Promise<void> {
  const now = opts.now ?? new Date();
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const perTenantBatchSize = opts.perTenantBatchSize ?? DEFAULT_PER_TENANT_BATCH_SIZE;
  const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const selection = await listDisputes(
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
      "dispute scanner hit batch cap",
    );
    deps.metrics?.increment(
      "brain.dispute.scan.dropped.count",
      { reason: "batch_cap" },
      omittedCount,
    );
  }

  const perTenant = new Map<string, number>();
  for (const row of candidates) {
    perTenant.set(row.tenant_id, (perTenant.get(row.tenant_id) ?? 0) + 1);
    const event = eventFor(row);
    const triggerKey = `dispute:${event}:${row.dispute_id}`;
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
          dispute_id: row.dispute_id,
          transaction_id: row.transaction_id,
          counterparty_id: row.counterparty_id,
          amount: row.amount,
          currency: row.currency,
          deadline: row.deadline,
          dispute_age_days: row.dispute_age_days,
          evidence_completeness: row.evidence_completeness,
          dispute_confidence: row.evidence_completeness,
          dispute_summary: `${event} dispute ${row.dispute_id}`,
        },
      });
      status = result.status;
      runId = result.run_id;
      proposalId = result.proposed?.id ?? null;
    } catch (err) {
      deps.log?.error(
        { err, tenantId: row.tenant_id, disputeId: row.dispute_id },
        "dispute run failed",
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
    deps.metrics?.increment("brain.dispute.scan.count", { tenant_id: tenantId }, count);
    deps.metrics?.gauge("brain.dispute.scan.last_success_unixtime", successUnix, {
      tenant_id: tenantId,
    });
  }
}

async function listDisputes(
  pool: Pool,
  now: Date,
  limit: number,
  perTenantLimit: number,
  cooldownMs: number,
): Promise<DisputeSelection> {
  const cutoff = new Date(now.getTime() - cooldownMs);
  const { rows } = await pool.query<DisputeDbRow>(
    `WITH candidates AS (
       SELECT o.owner_id AS tenant_id,
              o.id AS dispute_id,
              tx.id AS transaction_id,
              o.counterparty_id,
              o.amount_due::text AS amount,
              o.currency,
              o.due_date::text AS deadline,
              GREATEST(0, FLOOR(EXTRACT(EPOCH FROM ($2::timestamptz - o.created_at)) / 86400))::text AS dispute_age_days,
              LEAST(1, GREATEST(0, o.confidence))::text AS evidence_completeness,
              CASE WHEN o.external_key LIKE 'stripe:dispute:%' THEN 'chargeback.received' ELSE 'dispute.created' END AS event_hint
         FROM ledger_obligations o
         JOIN LATERAL (
           SELECT t.id
             FROM ledger_transactions t
            WHERE t.owner_id = o.owner_id
              AND (t.id = ANY(o.linked_transaction_ids) OR t.counterparty_id = o.counterparty_id)
            ORDER BY t.transaction_date DESC, t.id DESC
            LIMIT 1
         ) tx ON true
        WHERE o.status = 'disputed'
     ),
     eligible AS (
       SELECT c.*,
              row_number() OVER (PARTITION BY c.tenant_id ORDER BY c.deadline ASC, c.dispute_id ASC) AS tenant_rank,
              COUNT(*) OVER() AS eligible_count
         FROM candidates c
         LEFT JOIN agent_trigger_cooldowns cd
           ON cd.tenant_id = c.tenant_id
          AND cd.agent_key = 'dispute'
          AND cd.receivable_kind = 'dispute'
          AND cd.receivable_id = c.dispute_id
          AND cd.aging_tier = 'dispute'
        WHERE cd.id IS NULL OR cd.last_enqueued_at < $1::timestamptz
     ),
     fair AS (
       SELECT * FROM eligible WHERE tenant_rank <= $3
     )
     SELECT *, COUNT(*) OVER() AS fair_count
       FROM fair
      ORDER BY deadline ASC, dispute_id ASC
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
  row: DisputeCandidateRow,
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
       VALUES ($1, current_setting('app.tenant_id', true), 'dispute', $2, 'dispute', $3,
         $4, $5::timestamptz, 'claimed')
       ON CONFLICT (tenant_id, trigger_key) DO UPDATE SET
         last_enqueued_at = EXCLUDED.last_enqueued_at,
         last_status = 'claimed',
         updated_at = now()
       WHERE agent_trigger_cooldowns.last_enqueued_at < $6::timestamptz
       RETURNING trigger_key`,
      [triggerKey, event, row.dispute_id, COOLDOWN_TIER, now.toISOString(), cutoff.toISOString()],
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

function eventFor(row: DisputeCandidateRow): DomainEvent {
  return row.event_hint === "chargeback.received" ? "chargeback.received" : "dispute.created";
}

function normalizeCount(value: number | string | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}
