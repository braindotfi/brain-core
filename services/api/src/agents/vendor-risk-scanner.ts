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
const SCANNER_ACTOR = "vendor_risk_scanner";
const COOLDOWN_TIER = "vendor_risk";

export interface VendorRiskRow {
  readonly tenant_id: string;
  readonly counterparty_id: string;
  readonly vendor_name: string;
  readonly verified_status: string | null;
  readonly risk_level: string | null;
  readonly created_at: string;
  readonly payment_destination_id: string | null;
  readonly payment_destination_changed_at: string | null;
  readonly prior_destination_hash: string | null;
  readonly current_destination_hash: string | null;
  readonly destination_name: string | null;
  readonly history_risk_score: string;
  readonly event_hint: string;
}

export interface VendorRiskScannerDeps {
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

export interface VendorRiskScannerOptions {
  readonly intervalMs?: number;
  readonly batchSize?: number;
  readonly perTenantBatchSize?: number;
  readonly cooldownMs?: number;
  readonly now?: Date;
}

interface VendorRiskSelection {
  readonly rows: VendorRiskRow[];
  readonly totalEligible: number;
  readonly totalFair: number;
}

interface VendorRiskDbRow extends VendorRiskRow {
  readonly eligible_count?: number | string;
  readonly fair_count?: number | string;
}

export function startVendorRiskScanner(
  deps: VendorRiskScannerDeps,
  opts: VendorRiskScannerOptions = {},
): ManagedWorker {
  return startManagedInterval(
    () => runVendorRiskScanCycle(deps, opts),
    opts.intervalMs ?? DEFAULT_INTERVAL_MS,
    {
      name: "vendor-risk-scanner",
      runImmediately: false,
      onError: (err) => deps.log?.error({ err }, "vendor risk scanner failed"),
    },
  );
}

export async function runVendorRiskScanCycle(
  deps: VendorRiskScannerDeps,
  opts: VendorRiskScannerOptions = {},
): Promise<void> {
  const now = opts.now ?? new Date();
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const perTenantBatchSize = opts.perTenantBatchSize ?? DEFAULT_PER_TENANT_BATCH_SIZE;
  const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const selection = await listVendorRiskRows(
    deps.scanPool,
    now,
    batchSize + 1,
    perTenantBatchSize,
    cooldownMs,
  );
  const capped = selection.totalFair > batchSize;
  const vendors = selection.rows.slice(0, batchSize);
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
      "vendor risk scanner hit batch cap",
    );
    deps.metrics?.increment(
      "brain.vendor_risk.scan.dropped.count",
      { reason: "batch_cap" },
      omittedCount,
    );
  }

  const perTenant = new Map<string, number>();
  for (const row of vendors) {
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
          counterparty_id: row.counterparty_id,
          vendor_id: row.counterparty_id,
          vendor_name: row.vendor_name,
          // VR-1 live path: unverified vendor identity must hard-hold in the
          // handler instead of being treated as a scored residual.
          identity_resolved: isVerifiedVendorStatus(row.verified_status),
          verified_status: row.verified_status ?? "unverified",
          risk_level: row.risk_level,
          created_at: row.created_at,
          payment_destination_id: row.payment_destination_id,
          payment_destination_changed_at: row.payment_destination_changed_at,
          prior_destination_hash: row.prior_destination_hash,
          current_destination_hash: row.current_destination_hash,
          destination_name: row.destination_name,
          counterparty_history_id: row.payment_destination_id,
          counterparty_history_changed_at: row.payment_destination_changed_at,
          history_risk_score: row.history_risk_score,
        },
      });
      status = result.status;
      runId = result.run_id;
      proposalId = result.proposed?.id ?? null;
    } catch (err) {
      deps.log?.error(
        { err, tenantId: row.tenant_id, counterpartyId: row.counterparty_id },
        "vendor risk run failed",
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
    deps.metrics?.increment("brain.vendor_risk.scan.count", { tenant_id: tenantId }, count);
    deps.metrics?.gauge("brain.vendor_risk.scan.last_success_unixtime", successUnix, {
      tenant_id: tenantId,
    });
  }
}

async function listVendorRiskRows(
  pool: Pool,
  now: Date,
  limit: number,
  perTenantLimit: number,
  cooldownMs: number,
): Promise<VendorRiskSelection> {
  const cutoff = new Date(now.getTime() - cooldownMs);
  const { rows } = await pool.query<VendorRiskDbRow>(
    `WITH vendors AS (
       SELECT cp.owner_id AS tenant_id,
              cp.id AS counterparty_id,
              cp.name AS vendor_name,
              cp.verified_status,
              cp.risk_level,
              cp.created_at,
              cp.linked_accounts,
              latest.id AS payment_destination_id,
              latest.changed_at AS payment_destination_changed_at,
              latest.prior_hash AS prior_destination_hash,
              latest.current_hash AS current_destination_hash,
              latest.actor AS destination_name,
              CASE
                WHEN cp.verified_status IS NULL OR cp.verified_status IN ('unverified', 'self_attested') THEN 0.25
                ELSE 0
              END +
              CASE
                WHEN cp.created_at >= $1::timestamptz - interval '7 days' THEN 0.25
                ELSE 0
              END +
              CASE
                WHEN latest.changed_at >= $1::timestamptz - interval '7 days'
                  AND latest.prior_hash IS NOT NULL THEN 0.35
                ELSE 0
              END AS history_risk_score,
              CASE
                WHEN latest.source_id LIKE 'payment_destination:%' THEN 'payment.destination_changed'
                WHEN latest.prior_hash IS NOT NULL THEN 'vendor.bank_details_changed'
                ELSE 'vendor.created'
              END AS event_hint
         FROM ledger_counterparties cp
         LEFT JOIN LATERAL (
           SELECT cpi.*
             FROM ledger_counterparty_payment_instructions cpi
            WHERE cpi.owner_id = cp.owner_id
              AND cpi.counterparty_id = cp.id
            ORDER BY cpi.changed_at DESC, cpi.id ASC
            LIMIT 1
         ) latest ON true
        WHERE cp.type = 'vendor'
          AND (
            cp.created_at >= $1::timestamptz - interval '7 days'
            OR latest.changed_at >= $1::timestamptz - interval '7 days'
            OR cp.verified_status IS NULL
            OR cp.verified_status IN ('unverified', 'self_attested')
          )
     ),
     eligible AS (
       SELECT v.*,
              row_number() OVER (
                PARTITION BY v.tenant_id
                ORDER BY v.history_risk_score DESC, v.created_at ASC, v.counterparty_id ASC
              ) AS tenant_rank,
              COUNT(*) OVER() AS eligible_count
         FROM vendors v
         LEFT JOIN agent_trigger_cooldowns cd
           ON cd.tenant_id = v.tenant_id
          AND cd.agent_key = 'vendor_risk'
          AND cd.receivable_kind = 'counterparty'
          AND cd.receivable_id = v.counterparty_id
          AND cd.aging_tier = 'vendor_risk'
        WHERE cd.id IS NULL OR cd.last_enqueued_at < $2::timestamptz
     ),
     fair AS (
       SELECT *
         FROM eligible
        WHERE tenant_rank <= $3
     )
     SELECT tenant_id,
            counterparty_id,
            vendor_name,
            verified_status,
            risk_level,
            created_at::text AS created_at,
            payment_destination_id,
            payment_destination_changed_at::text AS payment_destination_changed_at,
            prior_destination_hash,
            current_destination_hash,
            destination_name,
            history_risk_score::text AS history_risk_score,
            event_hint,
            eligible_count,
            COUNT(*) OVER() AS fair_count
       FROM fair
      ORDER BY history_risk_score DESC, created_at ASC, counterparty_id ASC
      LIMIT $4`,
    [now.toISOString(), cutoff.toISOString(), perTenantLimit, limit],
  );
  const totalEligible = normalizeCount(rows[0]?.eligible_count, rows.length);
  const totalFair = normalizeCount(rows[0]?.fair_count, rows.length);
  return { rows, totalEligible, totalFair };
}

async function claimCooldown(
  pool: Pool,
  row: VendorRiskRow,
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
         $1, current_setting('app.tenant_id', true), 'vendor_risk', $2, 'counterparty', $3,
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

function isVerifiedVendorStatus(status: string | null): boolean {
  return status === "document_verified" || status === "sanctions_cleared";
}

function eventFor(row: VendorRiskRow): DomainEvent {
  if (
    row.event_hint === "vendor.bank_details_changed" ||
    row.event_hint === "payment.destination_changed"
  ) {
    return row.event_hint;
  }
  return "vendor.created";
}

function triggerKeyFor(row: VendorRiskRow, event: DomainEvent): string {
  return `vendor_risk:${event}:counterparty:${row.counterparty_id}:${COOLDOWN_TIER}`;
}

function normalizeCount(value: number | string | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}
