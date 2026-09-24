import type { Pool } from "pg";
import {
  InMemoryOfacScreener,
  InMemoryPepScreener,
  UnwiredKycStore,
  startManagedInterval,
  withTenantScope,
  type DomainEvent,
  type KycStore,
  type ManagedWorker,
  type MetricsEmitter,
  type OfacScreener,
  type PepScreener,
  type ServiceCallContext,
} from "@brain/shared";
import type { AgentRunService } from "@brain/agent-router";
import {
  AML_JURISDICTION_RULES,
  DEFAULT_AML_JURISDICTION_RULE,
  type AmlJurisdictionRule,
} from "./aml-compliance-config.js";

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_PER_TENANT_BATCH_SIZE = 25;
const DEFAULT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const SCANNER_ACTOR = "aml_compliance_scanner";
const COOLDOWN_TIER = "aml_compliance";

export interface AmlCompliancePaymentRow {
  readonly tenant_id: string;
  readonly payment_id: string;
  readonly beneficiary_id: string;
  readonly beneficiary_name: string | null;
  readonly amount: string;
  readonly currency: string;
  readonly payment_created_at: string;
  readonly source_jurisdiction: string | null;
  readonly beneficiary_jurisdiction: string | null;
}

export interface AmlComplianceScannerDeps {
  readonly scanPool: Pool;
  readonly appPool: Pool;
  readonly runService: Pick<AgentRunService, "run">;
  readonly ofacScreener?: OfacScreener;
  readonly pepScreener?: PepScreener;
  readonly kycStore?: KycStore;
  readonly metrics?: MetricsEmitter;
  readonly log?: {
    error(obj: unknown, msg?: string): void;
    warn(obj: unknown, msg?: string): void;
  };
}

export interface AmlComplianceScannerOptions {
  readonly intervalMs?: number;
  readonly batchSize?: number;
  readonly perTenantBatchSize?: number;
  readonly cooldownMs?: number;
  readonly now?: Date;
  readonly rules?: readonly AmlJurisdictionRule[];
}

interface AmlComplianceSelection {
  readonly rows: AmlCompliancePaymentRow[];
  readonly totalEligible: number;
  readonly totalFair: number;
}

interface AmlComplianceDbRow extends AmlCompliancePaymentRow {
  readonly eligible_count?: number | string;
  readonly fair_count?: number | string;
}

export function startAmlComplianceScanner(
  deps: AmlComplianceScannerDeps,
  opts: AmlComplianceScannerOptions = {},
): ManagedWorker {
  return startManagedInterval(
    () => runAmlComplianceScanCycle(deps, opts),
    opts.intervalMs ?? DEFAULT_INTERVAL_MS,
    {
      name: "aml-compliance-scanner",
      runImmediately: false,
      onError: (err) => deps.log?.error({ err }, "aml compliance scanner failed"),
    },
  );
}

export async function runAmlComplianceScanCycle(
  deps: AmlComplianceScannerDeps,
  opts: AmlComplianceScannerOptions = {},
): Promise<void> {
  const now = opts.now ?? new Date();
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const perTenantBatchSize = opts.perTenantBatchSize ?? DEFAULT_PER_TENANT_BATCH_SIZE;
  const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const rules = opts.rules ?? AML_JURISDICTION_RULES;
  const ofacScreener = deps.ofacScreener ?? new InMemoryOfacScreener();
  const pepScreener = deps.pepScreener ?? new InMemoryPepScreener();
  const kycStore = deps.kycStore ?? new UnwiredKycStore();
  const selection = await listAmlCompliancePayments(
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
      "aml compliance scanner hit batch cap",
    );
    deps.metrics?.increment(
      "brain.aml_compliance.scan.dropped.count",
      { reason: "batch_cap" },
      omittedCount,
    );
  }

  const perTenant = new Map<string, number>();
  for (const row of rows) {
    const jurisdictions = jurisdictionsFor(row);
    const rule = ruleFor(row, jurisdictions, rules);
    const kyc = await kycStore.getFreshness(row.tenant_id, row.beneficiary_id, now);
    const event = eventFor(row, jurisdictions, rule, kyc);
    if (event === null) continue;
    const triggerKey = triggerKeyFor(row, event);
    const claimed = await claimCooldown(deps.appPool, row, event, triggerKey, now, cooldownMs);
    if (!claimed) continue;

    perTenant.set(row.tenant_id, (perTenant.get(row.tenant_id) ?? 0) + 1);
    const subject = {
      tenant_id: row.tenant_id,
      beneficiary_id: row.beneficiary_id,
      beneficiary_name: row.beneficiary_name,
      jurisdictions_involved: jurisdictions,
    };
    const [ofac, pep] = await Promise.all([
      ofacScreener.screen(subject, now),
      pepScreener.screen(subject, now),
    ]);
    const deadline = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    const context = {
      payment_id: row.payment_id,
      beneficiary_id: row.beneficiary_id,
      counterparty_id: row.beneficiary_id,
      destination_counterparty_id: row.beneficiary_id,
      amount: row.amount,
      currency: row.currency,
      jurisdictions_involved: jurisdictions,
      screenings: {
        ofac,
        pep,
        kyc_freshness: kyc ?? { status: "unknown", note: "kyc_store_returned_no_record" },
      },
      required_documents: requiredDocumentsFor(rule, kyc),
      regulatory_context: {
        jurisdiction: rule.jurisdiction,
        regulation_id: rule.regulation_id,
        threshold: rule.threshold,
        purpose_code_required: rule.purpose_code_required,
      },
      recommended_action: recommendedActionFor(ofac.status, pep.status),
      deadline,
      decision_context: decisionContextFor(deadline),
    };

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
      deps.log?.error({ err, tenantId: row.tenant_id, paymentId: row.payment_id });
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
    deps.metrics?.increment("brain.aml_compliance.scan.count", { tenant_id: tenantId }, count);
    deps.metrics?.gauge("brain.aml_compliance.scan.last_success_unixtime", successUnix, {
      tenant_id: tenantId,
    });
  }
}

async function listAmlCompliancePayments(
  pool: Pool,
  now: Date,
  limit: number,
  perTenantLimit: number,
  cooldownMs: number,
): Promise<AmlComplianceSelection> {
  const cutoff = new Date(now.getTime() - cooldownMs);
  const { rows } = await pool.query<AmlComplianceDbRow>(
    `WITH candidates AS (
       SELECT pi.owner_id AS tenant_id,
              pi.id AS payment_id,
              pi.destination_counterparty_id AS beneficiary_id,
              cp.name AS beneficiary_name,
              pi.amount::text AS amount,
              pi.currency,
              pi.created_at::text AS payment_created_at,
              NULL::text AS source_jurisdiction,
              COALESCE(
                cp.metadata->>'jurisdiction',
                cp.metadata->>'country',
                cp.metadata #>> '{location,country}'
              ) AS beneficiary_jurisdiction
         FROM ledger_payment_intents pi
         JOIN ledger_accounts acct
           ON acct.id = pi.source_account_id AND acct.owner_id = pi.owner_id
         JOIN ledger_counterparties cp
           ON cp.id = pi.destination_counterparty_id AND cp.owner_id = pi.owner_id
        WHERE pi.action_type = 'wire'
          AND pi.status IN ('proposed', 'pending_approval', 'approved', 'paused')
     ),
     eligible AS (
       SELECT c.*,
              row_number() OVER (
                PARTITION BY c.tenant_id
                ORDER BY c.payment_created_at DESC, c.payment_id ASC
              ) AS tenant_rank,
              COUNT(*) OVER() AS eligible_count
         FROM candidates c
         LEFT JOIN agent_trigger_cooldowns cd
           ON cd.tenant_id = c.tenant_id
          AND cd.agent_key = 'aml_compliance'
          AND cd.receivable_kind = 'payment_intent'
          AND cd.receivable_id = c.payment_id
          AND cd.aging_tier = 'aml_compliance'
        WHERE cd.id IS NULL OR cd.last_enqueued_at < $1::timestamptz
     ),
     fair AS (
       SELECT * FROM eligible WHERE tenant_rank <= $2
     )
     SELECT *, COUNT(*) OVER() AS fair_count
       FROM fair
      ORDER BY payment_created_at DESC, payment_id ASC
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
  row: AmlCompliancePaymentRow,
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
       VALUES ($1, current_setting('app.tenant_id', true), 'aml_compliance', $2,
         'payment_intent', $3, $4, $5::timestamptz, 'claimed')
       ON CONFLICT (tenant_id, trigger_key) DO UPDATE SET
         last_enqueued_at = EXCLUDED.last_enqueued_at,
         last_status = 'claimed',
         updated_at = now()
       WHERE agent_trigger_cooldowns.last_enqueued_at < $6::timestamptz
       RETURNING trigger_key`,
      [triggerKey, event, row.payment_id, COOLDOWN_TIER, now.toISOString(), cutoff.toISOString()],
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

function eventFor(
  row: AmlCompliancePaymentRow,
  jurisdictions: readonly string[],
  rule: AmlJurisdictionRule,
  kyc: { readonly status?: string } | null,
): DomainEvent | null {
  if (jurisdictions.length > 1) return "payment.cross_border_created";
  const aboveThreshold = Number(row.amount) >= Number(rule.threshold);
  if (aboveThreshold && row.currency === rule.currency) {
    return "payment.above_regulatory_threshold";
  }
  if (kyc?.status === "stale") return "kyc.beneficiary_stale";
  return null;
}

function triggerKeyFor(row: AmlCompliancePaymentRow, event: DomainEvent): string {
  return `aml_compliance:${event}:payment_intent:${row.payment_id}:${COOLDOWN_TIER}`;
}

function jurisdictionsFor(row: AmlCompliancePaymentRow): string[] {
  return [row.source_jurisdiction, row.beneficiary_jurisdiction]
    .map((value) => (typeof value === "string" ? value.trim().toUpperCase() : ""))
    .filter(
      (value, index, all): value is string => value.length > 0 && all.indexOf(value) === index,
    );
}

function ruleFor(
  row: AmlCompliancePaymentRow,
  jurisdictions: readonly string[],
  rules: readonly AmlJurisdictionRule[],
): AmlJurisdictionRule {
  return (
    rules.find(
      (rule) => rule.currency === row.currency && jurisdictions.includes(rule.jurisdiction),
    ) ??
    rules.find((rule) => rule.currency === row.currency) ??
    DEFAULT_AML_JURISDICTION_RULE
  );
}

function requiredDocumentsFor(
  rule: AmlJurisdictionRule,
  kyc: { readonly status?: string } | null,
): Array<Record<string, unknown>> {
  return rule.required_documents.map((doc) => ({
    ...doc,
    status: doc.type === "beneficiary_kyc" && kyc?.status === "fresh" ? "cleared" : "needed",
  }));
}

function recommendedActionFor(ofacStatus: string, pepStatus: string): "provide_docs" | "hold" {
  if (
    ofacStatus === "match" ||
    ofacStatus === "possible_match" ||
    pepStatus === "match" ||
    pepStatus === "possible_match"
  ) {
    return "hold";
  }
  return "provide_docs";
}

function decisionContextFor(deadline: string): Record<string, unknown> {
  return {
    decide_by: `Before compliance deadline ${deadline}`,
    if_wrong:
      "Releasing too early can breach AML obligations. Holding too long can delay a legitimate payment.",
    reversible: {
      state: "no",
      label: "No after wire release",
    },
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
