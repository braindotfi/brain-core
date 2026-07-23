import type { Pool } from "pg";
import { withTenantScope, type AuditEmitter, type ServiceCallContext } from "@brain/shared";
import type { AgentRunService } from "@brain/agent-router";
import type { LedgerUploadProjectedEvent } from "@brain/canonical";

const ACTOR = "system:upload-projection-trigger";
const EVENT = "ledger.upload.projected";
const MAX_FANOUT = 5;

type TriggerAgent = "collections" | "cash_forecast" | "treasury" | "vendor_risk" | "reconciliation";

export interface UploadProjectionAgentTriggerDeps {
  readonly pool: Pool;
  readonly runService: Pick<AgentRunService, "run">;
  readonly audit: AuditEmitter;
  readonly log?: {
    error(obj: unknown, msg?: string): void;
    warn(obj: unknown, msg?: string): void;
  };
}

export function createUploadProjectionAgentTrigger(deps: UploadProjectionAgentTriggerDeps): {
  handle(event: LedgerUploadProjectedEvent): Promise<void>;
} {
  return {
    handle: (event) => runUploadProjectionAgentTrigger(deps, event),
  };
}

export async function runUploadProjectionAgentTrigger(
  deps: UploadProjectionAgentTriggerDeps,
  event: LedgerUploadProjectedEvent,
): Promise<void> {
  const targets = await selectTargets(deps.pool, event);
  for (const agent of targets.slice(0, MAX_FANOUT)) {
    try {
      const context = await contextForAgent(deps.pool, event, agent);
      if (context === null) continue;
      const result = await deps.runService.run(ctxFor(event.tenantId), {
        tenant_id: event.tenantId,
        event: EVENT,
        target_agent_id: agent,
        idempotency_key: idempotencyKey(event, agent),
        context: {
          ...context,
          raw_artifact_id: event.rawArtifactId,
          raw_parsed_id: event.rawParsedId,
          projection_summary: event.summary,
        },
      });
      await deps.audit.emit({
        tenantId: event.tenantId,
        layer: "agent",
        eventType: result.status === "proposal_created" ? "assistant_activity" : "system_activity",
        actor: ACTOR,
        action: "agent.upload_projection.run",
        inputs: {
          event: EVENT,
          raw_artifact_id: event.rawArtifactId,
          agent_id: agent,
        },
        outputs: {
          status: result.status,
          run_id: result.run_id,
          proposal_id: result.proposed?.id ?? null,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.log?.error(
        { err, tenantId: event.tenantId, rawArtifactId: event.rawArtifactId, agent },
        "upload projection agent run failed",
      );
      await deps.audit.emit({
        tenantId: event.tenantId,
        layer: "agent",
        eventType: "system_activity",
        severity: "warning",
        actor: ACTOR,
        action: "agent.upload_projection.run_failed",
        inputs: {
          event: EVENT,
          raw_artifact_id: event.rawArtifactId,
          agent_id: agent,
        },
        outputs: { error: message },
      });
    }
  }
}

async function selectTargets(
  pool: Pool,
  event: LedgerUploadProjectedEvent,
): Promise<TriggerAgent[]> {
  const out: TriggerAgent[] = [];
  if (event.summary.receivables > 0) out.push("collections");
  if (event.summary.transactions > 0) out.push("cash_forecast", "treasury");
  if (event.summary.newCounterparties > 0) out.push("vendor_risk");
  if (event.summary.transactions > 0 && (await tenantHasReceivables(pool, event.tenantId))) {
    out.push("reconciliation");
  }
  return out;
}

async function tenantHasReceivables(pool: Pool, tenantId: string): Promise<boolean> {
  return withTenantScope(pool, tenantId, async (client) => {
    const { rows } = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM ledger_obligations
          WHERE owner_id = current_setting('app.tenant_id', true)
            AND direction = 'receivable'
          LIMIT 1
       )`,
    );
    return rows[0]?.exists ?? false;
  });
}

async function contextForAgent(
  pool: Pool,
  event: LedgerUploadProjectedEvent,
  agent: TriggerAgent,
): Promise<Record<string, unknown> | null> {
  if (agent === "collections") return collectionsContext(pool, event);
  if (agent === "cash_forecast" || agent === "treasury") return cashContext(pool, event);
  if (agent === "vendor_risk") return vendorRiskContext(pool, event);
  return reconciliationContext(pool, event);
}

async function collectionsContext(
  pool: Pool,
  event: LedgerUploadProjectedEvent,
): Promise<Record<string, unknown> | null> {
  return withTenantScope(pool, event.tenantId, async (client) => {
    const { rows } = await client.query<ReceivableRow>(
      `SELECT o.id,
              COALESCE(NULLIF(o.metadata #>> '{document_upload,invoice_ref}', ''), o.id)
                AS invoice_number,
              o.counterparty_id,
              cp.name AS counterparty_name,
              o.amount_due::text AS amount,
              o.currency,
              o.due_date::text AS due_date,
              GREATEST(FLOOR(EXTRACT(EPOCH FROM (now() - o.due_date)) / 86400), 1)::int
                AS days_overdue,
              CASE
                WHEN now() - o.due_date >= interval '90 days' THEN '90_plus'
                WHEN now() - o.due_date >= interval '60 days' THEN '60_89'
                WHEN now() - o.due_date >= interval '30 days' THEN '30_59'
                WHEN now() - o.due_date >= interval '15 days' THEN '15_29'
                ELSE '1_14'
              END AS aging_tier
         FROM ledger_obligations o
         JOIN ledger_counterparties cp
           ON cp.id = o.counterparty_id AND cp.owner_id = o.owner_id
        WHERE o.owner_id = current_setting('app.tenant_id', true)
          AND o.direction = 'receivable'
          AND $1 = ANY(o.source_ids)
          AND o.status IN ('due', 'overdue', 'upcoming')
        ORDER BY o.due_date ASC, o.id ASC
        LIMIT 1`,
      [event.rawArtifactId],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      invoice_id: row.id,
      obligation_id: row.id,
      invoice_number: row.invoice_number,
      counterparty_id: row.counterparty_id,
      counterparty_name: row.counterparty_name,
      amount: row.amount,
      currency: row.currency,
      due_date: row.due_date,
      days_overdue: row.days_overdue,
      aging_tier: row.aging_tier,
    };
  });
}

async function cashContext(
  pool: Pool,
  event: LedgerUploadProjectedEvent,
): Promise<Record<string, unknown> | null> {
  return withTenantScope(pool, event.tenantId, async (client) => {
    const { rows } = await client.query<CashPositionRow>(
      `SELECT a.id AS account_id,
              a.id AS balance_id,
              a.current_balance::text AS current_balance,
              a.currency,
              COALESCE(receivable.items, '[]'::jsonb) AS receivables,
              COALESCE(payable.items, '[]'::jsonb) AS payables
         FROM ledger_accounts a
         LEFT JOIN LATERAL (
           SELECT jsonb_agg(
                    jsonb_build_object(
                      'obligation_id', o.id,
                      'amount', o.amount_due::text,
                      'currency', o.currency,
                      'due_date', o.due_date::text,
                      'counterparty_id', o.counterparty_id,
                      'counterparty_name', cp.name
                    )
                    ORDER BY o.due_date ASC, o.id ASC
                  ) AS items
             FROM ledger_obligations o
             JOIN ledger_counterparties cp
               ON cp.id = o.counterparty_id AND cp.owner_id = o.owner_id
            WHERE o.owner_id = a.owner_id
              AND o.direction = 'receivable'
              AND o.status IN ('due', 'overdue', 'upcoming')
              AND o.currency = a.currency
         ) receivable ON true
         LEFT JOIN LATERAL (
           SELECT jsonb_agg(
                    jsonb_build_object(
                      'obligation_id', o.id,
                      'amount', o.amount_due::text,
                      'currency', o.currency,
                      'due_date', o.due_date::text,
                      'counterparty_id', o.counterparty_id,
                      'counterparty_name', cp.name
                    )
                    ORDER BY o.due_date ASC, o.id ASC
                  ) AS items
             FROM ledger_obligations o
             JOIN ledger_counterparties cp
               ON cp.id = o.counterparty_id AND cp.owner_id = o.owner_id
            WHERE o.owner_id = a.owner_id
              AND o.direction = 'payable'
              AND o.status IN ('due', 'overdue', 'upcoming')
              AND o.currency = a.currency
         ) payable ON true
        WHERE a.owner_id = current_setting('app.tenant_id', true)
          AND $1 = ANY(a.source_ids)
          AND a.current_balance IS NOT NULL
        ORDER BY a.updated_at DESC, a.id ASC
        LIMIT 1`,
      [event.rawArtifactId],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      account_id: row.account_id,
      balance_id: row.balance_id,
      current_balance: row.current_balance,
      currency: row.currency,
      receivables: asArray(row.receivables),
      payables: asArray(row.payables),
      thresholds: {
        shortfall_floor: "0.00",
        operating_minimum: "25000.00",
        sweep_surplus_floor: "50000.00",
        surplus_floor: "50000.00",
      },
    };
  });
}

async function vendorRiskContext(
  pool: Pool,
  event: LedgerUploadProjectedEvent,
): Promise<Record<string, unknown> | null> {
  return withTenantScope(pool, event.tenantId, async (client) => {
    const { rows } = await client.query<VendorRow>(
      `SELECT id, name, type, verified_status::text AS verified_status, created_at::text AS created_at
         FROM ledger_counterparties
        WHERE owner_id = current_setting('app.tenant_id', true)
          AND $1 = ANY(source_ids)
        ORDER BY created_at ASC, id ASC
        LIMIT 1`,
      [event.rawArtifactId],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      counterparty_id: row.id,
      vendor_id: row.id,
      counterparty_name: row.name,
      vendor_name: row.name,
      verified_status: row.verified_status ?? "unverified",
      created_at: row.created_at,
      identity_resolved: row.type === "vendor",
    };
  });
}

async function reconciliationContext(
  pool: Pool,
  event: LedgerUploadProjectedEvent,
): Promise<Record<string, unknown> | null> {
  return withTenantScope(pool, event.tenantId, async (client) => {
    const { rows } = await client.query<ReconciliationRow>(
      `SELECT tx.id AS transaction_id,
              tx.amount::text AS amount,
              tx.currency,
              tx.direction,
              tx.transaction_date::text AS transaction_date,
              tx.counterparty_id,
              cp.name AS counterparty_name,
              COALESCE(candidates.items, '[]'::jsonb) AS candidates
         FROM ledger_transactions tx
         LEFT JOIN ledger_counterparties cp
           ON cp.id = tx.counterparty_id AND cp.owner_id = tx.owner_id
         LEFT JOIN LATERAL (
           SELECT jsonb_agg(
                    jsonb_build_object(
                      'kind', 'obligation',
                      'id', o.id,
                      'amount', o.amount_due::text,
                      'currency', o.currency,
                      'date', o.due_date::text,
                      'counterparty_id', o.counterparty_id,
                      'counterparty_name', ocp.name,
                      'label', o.type,
                      'status', o.status
                    )
                    ORDER BY o.due_date ASC, o.id ASC
                  ) AS items
             FROM ledger_obligations o
             JOIN ledger_counterparties ocp
               ON ocp.id = o.counterparty_id AND ocp.owner_id = o.owner_id
            WHERE o.owner_id = tx.owner_id
              AND o.currency = tx.currency
              AND o.status IN ('due', 'overdue', 'upcoming')
         ) candidates ON true
        WHERE tx.owner_id = current_setting('app.tenant_id', true)
          AND $1 = ANY(tx.source_ids)
          AND tx.reconciliation_status = 'unreconciled'
        ORDER BY tx.transaction_date ASC, tx.id ASC
        LIMIT 1`,
      [event.rawArtifactId],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      transaction_id: row.transaction_id,
      amount: row.amount,
      currency: row.currency,
      direction: row.direction,
      transaction_date: row.transaction_date,
      counterparty_id: row.counterparty_id,
      counterparty_name: row.counterparty_name,
      candidates: asArray(row.candidates),
    };
  });
}

function ctxFor(tenantId: string): ServiceCallContext {
  return { tenantId, actor: ACTOR };
}

function idempotencyKey(event: LedgerUploadProjectedEvent, agent: TriggerAgent): string {
  return [event.tenantId, EVENT, event.rawArtifactId, agent].join(":");
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

interface ReceivableRow {
  readonly id: string;
  readonly invoice_number: string;
  readonly counterparty_id: string;
  readonly counterparty_name: string;
  readonly amount: string;
  readonly currency: string;
  readonly due_date: string;
  readonly days_overdue: number;
  readonly aging_tier: string;
}

interface CashPositionRow {
  readonly account_id: string;
  readonly balance_id: string;
  readonly current_balance: string;
  readonly currency: string;
  readonly receivables: unknown;
  readonly payables: unknown;
}

interface VendorRow {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly verified_status: string | null;
  readonly created_at: string;
}

interface ReconciliationRow {
  readonly transaction_id: string;
  readonly amount: string;
  readonly currency: string;
  readonly direction: string;
  readonly transaction_date: string;
  readonly counterparty_id: string | null;
  readonly counterparty_name: string | null;
  readonly candidates: unknown;
}
