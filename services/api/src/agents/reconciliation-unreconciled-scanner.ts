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
const SCANNER_ACTOR = "reconciliation_unreconciled_scanner";
const COOLDOWN_TIER = "unreconciled";

export interface ReconciliationCandidateContext {
  readonly kind: "invoice" | "obligation" | "transaction";
  readonly id: string;
  readonly amount: string;
  readonly currency: string;
  readonly date: string;
  readonly counterparty_id: string | null;
  readonly counterparty_name: string | null;
  readonly label: string | null;
  readonly status: string | null;
}

export interface ReconciliationUnreconciledRow {
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
  readonly candidates: readonly ReconciliationCandidateContext[];
}

export interface ReconciliationScannerDeps {
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

export interface ReconciliationScannerOptions {
  readonly intervalMs?: number;
  readonly batchSize?: number;
  readonly perTenantBatchSize?: number;
  readonly cooldownMs?: number;
  readonly now?: Date;
}

interface ReconciliationSelection {
  readonly rows: ReconciliationUnreconciledRow[];
  readonly totalEligible: number;
  readonly totalFair: number;
}

export function startReconciliationUnreconciledScanner(
  deps: ReconciliationScannerDeps,
  opts: ReconciliationScannerOptions = {},
): ManagedWorker {
  return startManagedInterval(
    () => runReconciliationUnreconciledScanCycle(deps, opts),
    opts.intervalMs ?? DEFAULT_INTERVAL_MS,
    {
      name: "reconciliation-unreconciled-scanner",
      runImmediately: false,
      onError: (err) => deps.log?.error({ err }, "reconciliation unreconciled scanner failed"),
    },
  );
}

export async function runReconciliationUnreconciledScanCycle(
  deps: ReconciliationScannerDeps,
  opts: ReconciliationScannerOptions = {},
): Promise<void> {
  const now = opts.now ?? new Date();
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const perTenantBatchSize = opts.perTenantBatchSize ?? DEFAULT_PER_TENANT_BATCH_SIZE;
  const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const selection = await listUnreconciledTransactions(
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
      "reconciliation unreconciled scanner hit batch cap",
    );
    deps.metrics?.increment(
      "brain.reconciliation.scan.dropped.count",
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
          candidates: row.candidates,
        },
      });
      status = result.status;
      runId = result.run_id;
      proposalId = result.proposed?.id ?? null;
    } catch (err) {
      deps.log?.error(
        { err, tenantId: row.tenant_id, transactionId: row.transaction_id },
        "reconciliation unreconciled run failed",
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
    deps.metrics?.increment("brain.reconciliation.scan.count", { tenant_id: tenantId }, count);
    deps.metrics?.gauge("brain.reconciliation.scan.last_success_unixtime", successUnix, {
      tenant_id: tenantId,
    });
  }
}

async function listUnreconciledTransactions(
  pool: Pool,
  now: Date,
  limit: number,
  perTenantLimit: number,
  cooldownMs: number,
): Promise<ReconciliationSelection> {
  const cutoff = new Date(now.getTime() - cooldownMs);
  const { rows } = await pool.query<
    Omit<ReconciliationUnreconciledRow, "candidates"> & {
      candidates: unknown;
      eligible_count?: number | string;
      fair_count?: number | string;
    }
  >(
    `WITH base AS (
       SELECT tx.owner_id AS tenant_id,
              tx.id AS transaction_id,
              tx.account_id,
              tx.amount AS amount_value,
              tx.amount::text AS amount,
              tx.currency,
              tx.direction,
              tx.transaction_date,
              tx.counterparty_id,
              cp.name AS counterparty_name,
              COALESCE(tx.description_normalized, tx.description_raw) AS description
         FROM ledger_transactions tx
         LEFT JOIN ledger_counterparties cp
           ON cp.id = tx.counterparty_id AND cp.owner_id = tx.owner_id
        WHERE tx.reconciliation_status = 'unreconciled'
          AND tx.status IN ('posted', 'cleared')
          AND tx.transaction_date <= $1::timestamptz
     ),
     with_candidates AS (
       SELECT b.*,
              COALESCE(candidates.items, '[]'::jsonb) AS candidates
         FROM base b
         LEFT JOIN LATERAL (
           SELECT jsonb_agg(to_jsonb(candidate) ORDER BY candidate.sort_score DESC, candidate.id ASC) AS items
             FROM (
               SELECT *
                 FROM (
                   SELECT 'invoice'::text AS kind,
                          i.id,
                          (i.amount_due - i.amount_paid)::text AS amount,
                          i.currency,
                          COALESCE(i.due_date, i.issue_date) AS date,
                          i.counterparty_id,
                          icp.name AS counterparty_name,
                          i.invoice_number AS label,
                          i.status,
                          (CASE WHEN i.currency = b.currency AND i.amount_due - i.amount_paid = b.amount_value THEN 2 ELSE 0 END) +
                          (CASE WHEN i.counterparty_id = b.counterparty_id THEN 2 ELSE 0 END) +
                          (CASE WHEN ABS(EXTRACT(EPOCH FROM (COALESCE(i.due_date, i.issue_date) - b.transaction_date))) <= 86400 THEN 1 ELSE 0 END)
                            AS sort_score
                     FROM ledger_invoices i
                     JOIN ledger_counterparties icp
                       ON icp.id = i.counterparty_id AND icp.owner_id = i.owner_id
                    WHERE i.owner_id = b.tenant_id
                      AND i.status IN ('sent', 'partial', 'overdue')
                      AND i.currency = b.currency
                      AND i.amount_paid < i.amount_due
                   UNION ALL
                   SELECT 'obligation'::text AS kind,
                          o.id,
                          o.amount_due::text AS amount,
                          o.currency,
                          o.due_date AS date,
                          o.counterparty_id,
                          ocp.name AS counterparty_name,
                          o.type AS label,
                          o.status,
                          (CASE WHEN o.currency = b.currency AND o.amount_due = b.amount_value THEN 2 ELSE 0 END) +
                          (CASE WHEN o.counterparty_id = b.counterparty_id THEN 2 ELSE 0 END) +
                          (CASE WHEN ABS(EXTRACT(EPOCH FROM (o.due_date - b.transaction_date))) <= 86400 THEN 1 ELSE 0 END)
                            AS sort_score
                     FROM ledger_obligations o
                     JOIN ledger_counterparties ocp
                       ON ocp.id = o.counterparty_id AND ocp.owner_id = o.owner_id
                    WHERE o.owner_id = b.tenant_id
                      AND o.status IN ('upcoming', 'due', 'overdue')
                      AND o.currency = b.currency
                   UNION ALL
                   SELECT 'transaction'::text AS kind,
                          other.id,
                          other.amount::text AS amount,
                          other.currency,
                          other.transaction_date AS date,
                          other.counterparty_id,
                          tcp.name AS counterparty_name,
                          COALESCE(other.description_normalized, other.description_raw) AS label,
                          other.status,
                          (CASE WHEN other.currency = b.currency AND other.amount = b.amount_value THEN 2 ELSE 0 END) +
                          (CASE WHEN other.counterparty_id = b.counterparty_id THEN 2 ELSE 0 END) +
                          (CASE WHEN ABS(EXTRACT(EPOCH FROM (other.transaction_date - b.transaction_date))) <= 86400 THEN 1 ELSE 0 END)
                            AS sort_score
                     FROM ledger_transactions other
                     LEFT JOIN ledger_counterparties tcp
                       ON tcp.id = other.counterparty_id AND tcp.owner_id = other.owner_id
                    WHERE other.owner_id = b.tenant_id
                      AND other.id <> b.transaction_id
                      AND other.status IN ('posted', 'cleared')
                      AND other.currency = b.currency
                 ) candidate_pool
                WHERE sort_score > 0
                ORDER BY sort_score DESC, id ASC
                LIMIT 5
             ) candidate
         ) candidates ON true
     ),
     eligible AS (
       SELECT wc.*,
              row_number() OVER (
                PARTITION BY wc.tenant_id
                ORDER BY wc.transaction_date ASC, wc.transaction_id ASC
              ) AS tenant_rank,
              COUNT(*) OVER() AS eligible_count
         FROM with_candidates wc
         LEFT JOIN agent_trigger_cooldowns cd
           ON cd.tenant_id = wc.tenant_id
          AND cd.agent_key = 'reconciliation'
          AND cd.receivable_kind = 'transaction'
          AND cd.receivable_id = wc.transaction_id
          AND cd.aging_tier = 'unreconciled'
        WHERE cd.id IS NULL OR cd.last_enqueued_at < $2::timestamptz
     ),
     fair AS (
       SELECT *
         FROM eligible
        WHERE tenant_rank <= $3
     )
     SELECT tenant_id,
            transaction_id,
            account_id,
            amount,
            currency,
            direction,
            transaction_date::text AS transaction_date,
            counterparty_id,
            counterparty_name,
            description,
            candidates,
            eligible_count,
            COUNT(*) OVER() AS fair_count
       FROM fair
      ORDER BY transaction_date ASC, transaction_id ASC
      LIMIT $4`,
    [now.toISOString(), cutoff.toISOString(), perTenantLimit, limit],
  );
  const totalEligible = normalizeCount(rows[0]?.eligible_count, rows.length);
  const totalFair = normalizeCount(rows[0]?.fair_count, rows.length);
  return {
    rows: rows.map((row) => ({ ...row, candidates: normalizeCandidates(row.candidates) })),
    totalEligible,
    totalFair,
  };
}

async function claimCooldown(
  pool: Pool,
  row: ReconciliationUnreconciledRow,
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
         $1, current_setting('app.tenant_id', true), 'reconciliation', $2, 'transaction', $3,
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

function eventFor(row: ReconciliationUnreconciledRow): DomainEvent {
  return row.candidates.length > 0 ? "reconciliation.candidate_found" : "transaction.unreconciled";
}

function triggerKeyFor(row: ReconciliationUnreconciledRow, event: DomainEvent): string {
  return `reconciliation:${event}:transaction:${row.transaction_id}:${COOLDOWN_TIER}`;
}

function normalizeCount(value: number | string | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function normalizeCandidates(raw: unknown): ReconciliationCandidateContext[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeCandidate)
    .filter((row): row is ReconciliationCandidateContext => row !== null);
}

function normalizeCandidate(raw: unknown): ReconciliationCandidateContext | null {
  if (typeof raw !== "object" || raw === null) return null;
  const row = raw as Record<string, unknown>;
  const kind = row.kind;
  if (kind !== "invoice" && kind !== "obligation" && kind !== "transaction") return null;
  const id = stringOrNull(row.id);
  const amount = stringOrNull(row.amount);
  const currency = stringOrNull(row.currency);
  const date = stringOrNull(row.date);
  if (id === null || amount === null || currency === null || date === null) return null;
  return {
    kind,
    id,
    amount,
    currency,
    date,
    counterparty_id: stringOrNull(row.counterparty_id),
    counterparty_name: stringOrNull(row.counterparty_name),
    label: stringOrNull(row.label),
    status: stringOrNull(row.status),
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
