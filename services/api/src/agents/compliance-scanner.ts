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
const SCANNER_ACTOR = "compliance_scanner";
const COOLDOWN_TIER_PREFIX = "compliance";

export interface ComplianceFindingRow {
  readonly tenant_id: string;
  readonly finding_id: string;
  readonly finding_type: string;
  readonly severity: string;
  readonly event_hint: string;
  readonly policy_decision_id: string;
  readonly audit_event_id: string;
  readonly payment_intent_id: string | null;
  readonly subject_type: string;
  readonly subject_id: string;
  readonly policy_outcome: string;
  readonly rule_id: string | null;
  readonly required_approvers_count: string;
  readonly valid_approval_count: string;
  readonly stale_approval_count: string;
  readonly detected_at: string;
}

export interface ComplianceScannerDeps {
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

export interface ComplianceScannerOptions {
  readonly intervalMs?: number;
  readonly batchSize?: number;
  readonly perTenantBatchSize?: number;
  readonly cooldownMs?: number;
  readonly now?: Date;
}

interface ComplianceSelection {
  readonly rows: ComplianceFindingRow[];
  readonly totalEligible: number;
  readonly totalFair: number;
}

interface ComplianceDbRow extends ComplianceFindingRow {
  readonly eligible_count?: number | string;
  readonly fair_count?: number | string;
}

export function startComplianceScanner(
  deps: ComplianceScannerDeps,
  opts: ComplianceScannerOptions = {},
): ManagedWorker {
  return startManagedInterval(
    () => runComplianceScanCycle(deps, opts),
    opts.intervalMs ?? DEFAULT_INTERVAL_MS,
    {
      name: "compliance-scanner",
      runImmediately: false,
      onError: (err) => deps.log?.error({ err }, "compliance scanner failed"),
    },
  );
}

export async function runComplianceScanCycle(
  deps: ComplianceScannerDeps,
  opts: ComplianceScannerOptions = {},
): Promise<void> {
  const now = opts.now ?? new Date();
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const perTenantBatchSize = opts.perTenantBatchSize ?? DEFAULT_PER_TENANT_BATCH_SIZE;
  const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const selection = await listComplianceFindings(
    deps.scanPool,
    now,
    batchSize + 1,
    perTenantBatchSize,
    cooldownMs,
  );
  const capped = selection.totalFair > batchSize;
  const findings = selection.rows.slice(0, batchSize);
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
      "compliance scanner hit batch cap",
    );
    deps.metrics?.increment(
      "brain.compliance.scan.dropped.count",
      { reason: "batch_cap" },
      omittedCount,
    );
  }

  const perTenant = new Map<string, number>();
  for (const row of findings) {
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
          finding_type: row.finding_type,
          severity: row.severity,
          rule_id: row.rule_id,
          policy_decision_id: row.policy_decision_id,
          audit_event_id: row.audit_event_id,
          payment_intent_id: row.payment_intent_id,
          subject_type: row.subject_type,
          subject_id: row.subject_id,
          policy_outcome: row.policy_outcome,
          required_approvers_count: row.required_approvers_count,
          valid_approval_count: row.valid_approval_count,
          stale_approval_count: row.stale_approval_count,
          audit_gap_detected: row.finding_type === "audit_gap_detected",
          policy_summary: `${row.policy_outcome} policy decision ${row.policy_decision_id}`,
          audit_summary: `${event} audit event ${row.audit_event_id}`,
        },
      });
      status = result.status;
      runId = result.run_id;
      proposalId = result.proposed?.id ?? null;
    } catch (err) {
      deps.log?.error(
        { err, tenantId: row.tenant_id, findingId: row.finding_id },
        "compliance run failed",
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
    deps.metrics?.increment("brain.compliance.scan.count", { tenant_id: tenantId }, count);
    deps.metrics?.gauge("brain.compliance.scan.last_success_unixtime", successUnix, {
      tenant_id: tenantId,
    });
  }
}

async function listComplianceFindings(
  pool: Pool,
  now: Date,
  limit: number,
  perTenantLimit: number,
  cooldownMs: number,
): Promise<ComplianceSelection> {
  const cutoff = new Date(now.getTime() - cooldownMs);
  const { rows } = await pool.query<ComplianceDbRow>(
    `WITH missing_approvals AS (
       SELECT pi.owner_id AS tenant_id,
              pi.id AS finding_id,
              CASE WHEN ev.id IS NULL THEN 'audit_gap_detected' ELSE 'approval_missing' END::text AS finding_type,
              CASE WHEN ev.id IS NULL THEN 'critical' ELSE 'medium' END::text AS severity,
              CASE WHEN ev.id IS NULL THEN 'audit.gap_detected' ELSE 'approval.missing' END::text AS event_hint,
              pd.id AS policy_decision_id,
              COALESCE(ev.id, 'audit_missing:' || pi.id) AS audit_event_id,
              pi.id AS payment_intent_id,
              pd.subject_type,
              pd.subject_id,
              pd.outcome AS policy_outcome,
              pd.matched_rule_id AS rule_id,
              GREATEST(COALESCE(array_length(pd.required_approvers, 1), 0), 1) AS required_approvers_count,
              COALESCE(ap.valid_count, 0) AS valid_approval_count,
              COALESCE(ap.stale_count, 0) AS stale_approval_count,
              GREATEST(pi.updated_at, pd.decided_at, COALESCE(ev.created_at, pi.updated_at, pd.decided_at)) AS detected_at
         FROM ledger_payment_intents pi
         JOIN policy_decisions pd
           ON pd.id = pi.policy_decision_id AND pd.tenant_id = pi.owner_id
         LEFT JOIN LATERAL (
           SELECT ae.id, ae.created_at
             FROM audit_events ae
            WHERE ae.tenant_id = pi.owner_id
              AND (
                ae.inputs->>'payment_intent_id' = pi.id
                OR ae.outputs->>'payment_intent_id' = pi.id
                OR ae.inputs->>'policy_decision_id' = pd.id
                OR ae.outputs->>'policy_decision_id' = pd.id
              )
            ORDER BY ae.created_at DESC, ae.id DESC
            LIMIT 1
         ) ev ON true
         LEFT JOIN LATERAL (
           SELECT COUNT(*) FILTER (WHERE a.status = 'valid' AND a.revoked_at IS NULL) AS valid_count,
                  COUNT(*) FILTER (WHERE a.status = 'stale') AS stale_count
             FROM approvals a
            WHERE a.tenant_id = pi.owner_id
              AND a.subject_type = 'payment_intent'
              AND a.subject_id = pi.id
         ) ap ON true
        WHERE pi.status IN ('approved', 'dispatching', 'executed')
          AND pi.policy_decision_id IS NOT NULL
          AND (pd.outcome = 'confirm' OR COALESCE(array_length(pd.required_approvers, 1), 0) > 0)
          AND COALESCE(ap.valid_count, 0) < GREATEST(COALESCE(array_length(pd.required_approvers, 1), 0), 1)
     ),
     policy_violations AS (
       SELECT pd.tenant_id,
              pd.id AS finding_id,
              'policy_violation'::text AS finding_type,
              'high'::text AS severity,
              'policy.violation'::text AS event_hint,
              pd.id AS policy_decision_id,
              ev.id AS audit_event_id,
              CASE WHEN pd.subject_type = 'payment_intent' THEN pd.subject_id ELSE NULL END AS payment_intent_id,
              pd.subject_type,
              pd.subject_id,
              pd.outcome AS policy_outcome,
              pd.matched_rule_id AS rule_id,
              COALESCE(array_length(pd.required_approvers, 1), 0) AS required_approvers_count,
              0 AS valid_approval_count,
              0 AS stale_approval_count,
              GREATEST(pd.decided_at, ev.created_at) AS detected_at
         FROM policy_decisions pd
         JOIN LATERAL (
           SELECT ae.id, ae.created_at
             FROM audit_events ae
            WHERE ae.tenant_id = pd.tenant_id
              AND (
                ae.inputs->>'policy_decision_id' = pd.id
                OR ae.outputs->>'policy_decision_id' = pd.id
                OR ae.inputs->>'subject_id' = pd.subject_id
                OR ae.outputs->>'subject_id' = pd.subject_id
              )
            ORDER BY ae.created_at DESC, ae.id DESC
            LIMIT 1
         ) ev ON true
        WHERE pd.outcome = 'reject'
     ),
     audit_gaps AS (
       SELECT pd.tenant_id,
              ae.id AS finding_id,
              'audit_gap_detected'::text AS finding_type,
              'critical'::text AS severity,
              'audit.gap_detected'::text AS event_hint,
              pd.id AS policy_decision_id,
              ae.id AS audit_event_id,
              CASE WHEN pd.subject_type = 'payment_intent' THEN pd.subject_id ELSE NULL END AS payment_intent_id,
              pd.subject_type,
              pd.subject_id,
              pd.outcome AS policy_outcome,
              pd.matched_rule_id AS rule_id,
              COALESCE(array_length(pd.required_approvers, 1), 0) AS required_approvers_count,
              0 AS valid_approval_count,
              0 AS stale_approval_count,
              ae.created_at AS detected_at
         FROM audit_events ae
         JOIN policy_decisions pd
           ON pd.tenant_id = ae.tenant_id
          AND pd.id = COALESCE(ae.inputs->>'policy_decision_id', ae.outputs->>'policy_decision_id')
        WHERE ae.action = 'audit.gap_detected'
           OR ae.outputs->>'audit_gap_detected' = 'true'
           OR ae.outputs->>'gap_detected' = 'true'
     ),
     findings AS (
       SELECT * FROM missing_approvals
       UNION ALL
       SELECT * FROM policy_violations
       UNION ALL
       SELECT * FROM audit_gaps
     ),
     eligible AS (
       SELECT f.*,
              row_number() OVER (
                PARTITION BY f.tenant_id
                ORDER BY
                  CASE f.severity
                    WHEN 'critical' THEN 4
                    WHEN 'high' THEN 3
                    WHEN 'medium' THEN 2
                    ELSE 1
                  END DESC,
                  f.detected_at DESC,
                  f.finding_id ASC
              ) AS tenant_rank,
              COUNT(*) OVER() AS eligible_count
         FROM findings f
         LEFT JOIN agent_trigger_cooldowns cd
           ON cd.tenant_id = f.tenant_id
          AND cd.agent_key = 'compliance'
          AND cd.receivable_kind = 'compliance_record'
          AND cd.receivable_id = f.finding_id
          AND cd.aging_tier = ('compliance_' || f.finding_type)
        WHERE cd.id IS NULL OR cd.last_enqueued_at < $1::timestamptz
     ),
     fair AS (
       SELECT *
         FROM eligible
        WHERE tenant_rank <= $2
     )
     SELECT tenant_id,
            finding_id,
            finding_type,
            severity,
            event_hint,
            policy_decision_id,
            audit_event_id,
            payment_intent_id,
            subject_type,
            subject_id,
            policy_outcome,
            rule_id,
            required_approvers_count::text AS required_approvers_count,
            valid_approval_count::text AS valid_approval_count,
            stale_approval_count::text AS stale_approval_count,
            detected_at::text AS detected_at,
            eligible_count,
            COUNT(*) OVER() AS fair_count
       FROM fair
      ORDER BY
        CASE severity
          WHEN 'critical' THEN 4
          WHEN 'high' THEN 3
          WHEN 'medium' THEN 2
          ELSE 1
        END DESC,
        detected_at DESC,
        finding_id ASC
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
  row: ComplianceFindingRow,
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
         $1, current_setting('app.tenant_id', true), 'compliance', $2, 'compliance_record', $3,
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
        row.finding_id,
        agingTierFor(row),
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

function eventFor(row: ComplianceFindingRow): DomainEvent {
  if (row.event_hint === "policy.violation" || row.event_hint === "audit.gap_detected") {
    return row.event_hint;
  }
  return "approval.missing";
}

function triggerKeyFor(row: ComplianceFindingRow, event: DomainEvent): string {
  return `compliance:${event}:${row.finding_id}:${agingTierFor(row)}`;
}

function agingTierFor(row: ComplianceFindingRow): string {
  return `${COOLDOWN_TIER_PREFIX}_${row.finding_type}`;
}

function normalizeCount(value: number | string | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}
