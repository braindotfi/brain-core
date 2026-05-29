/**
 * Tenant deletion service (GDPR right-to-erasure).
 *
 * Walks every tenant-scoped table across the six layers and deletes rows for
 * the target tenant. Runs in a single transaction under the brain_privileged
 * role (BYPASSRLS) so cross-tenant access barriers don't block the cleanup.
 *
 * Audit posture:
 *   - audit_events and audit_anchors are NOT deleted. The audit chain is the
 *     "verify without trusting Brain" surface; preserving it is a GDPR-
 *     compatible legitimate interest (forensic + financial integrity).
 *   - A `tenant.deleted` audit event is emitted at the end with per-layer
 *     row counts, so the deletion is itself verifiable on the chain.
 *
 * Caller responsibility (the route):
 *   - require principal_type=user
 *   - require principal.tenantId === target tenant
 *   - reject if either check fails
 *
 * Blob cleanup (Raw artifact storage) is intentionally NOT done here. Raw
 * artifacts that were tombstoned during the row deletion will be reaped by
 * the existing blob-retention worker on its own schedule.
 */

import type { Pool } from "pg";
import type { AuditEmitter, ServiceCallContext } from "@brain/shared";

export interface TenantDeletionResult {
  tenantId: string;
  deletedRows: Record<string, number>;
  totalRows: number;
}

/**
 * Tables to wipe, in deletion order. Children before parents where a foreign
 * key exists. The registry-derived test in service.test.ts scans every
 * migration in services/*​/migrations and asserts each tenant-scoped table
 * is either listed here OR in PRESERVED_TABLES — so a new migration that
 * adds a tenant-scoped table without updating this list fails CI.
 */
export const TENANT_SCOPED_TABLES: ReadonlyArray<{
  table: string;
  column: "owner_id" | "tenant_id";
}> = [
  // ---- Layer 1: Raw ----
  { table: "raw_parsed", column: "tenant_id" },
  { table: "raw_plaid_items", column: "tenant_id" },
  { table: "raw_artifacts", column: "tenant_id" },
  { table: "raw_sources", column: "tenant_id" },

  // ---- Layer 2: Ledger ----
  { table: "ledger_counterparty_payment_instructions", column: "owner_id" },
  { table: "ledger_reservations", column: "owner_id" },
  { table: "ledger_reconciliation_matches", column: "owner_id" },
  { table: "ledger_payment_intents", column: "owner_id" },
  { table: "ledger_transfers", column: "owner_id" },
  { table: "ledger_invoices", column: "owner_id" },
  { table: "ledger_obligations", column: "owner_id" },
  { table: "ledger_transactions", column: "owner_id" },
  { table: "ledger_documents", column: "owner_id" },
  { table: "ledger_balances", column: "owner_id" },
  { table: "ledger_accounts", column: "owner_id" },
  { table: "ledger_counterparties", column: "owner_id" },
  { table: "ledger_categories", column: "tenant_id" },
  { table: "normalization_log", column: "tenant_id" },

  // ---- Layer 3: Wiki ----
  { table: "wiki_relations", column: "tenant_id" },
  { table: "wiki_pages", column: "tenant_id" },
  { table: "wiki_entities", column: "tenant_id" },

  // ---- Layer 4: Policy ----
  { table: "policy_spend_counters", column: "tenant_id" },
  { table: "policy_decisions", column: "tenant_id" },
  { table: "policies", column: "tenant_id" },

  // ---- Layer 5: Agent / Execution ----
  // Children before parents (saga_steps→sagas, run_steps→runs, finding_overrides→findings).
  { table: "agent_saga_steps", column: "tenant_id" },
  { table: "agent_action_sagas", column: "tenant_id" },
  { table: "agent_finding_overrides", column: "tenant_id" },
  { table: "agent_findings", column: "tenant_id" },
  { table: "agent_run_steps", column: "tenant_id" },
  { table: "agent_reasoning_traces", column: "tenant_id" },
  { table: "agent_evidence_refs", column: "tenant_id" },
  { table: "agent_runs", column: "tenant_id" },
  { table: "agent_routing_decisions", column: "tenant_id" },
  { table: "agent_idempotency_keys", column: "tenant_id" },
  { table: "execution_outbox", column: "tenant_id" },
  { table: "executions", column: "tenant_id" },
  { table: "approvals", column: "tenant_id" },
  { table: "proposals", column: "tenant_id" },
  { table: "agents", column: "tenant_id" },

  // ---- Layer 6: Audit (metadata only; events + anchors preserved) ----
  { table: "webhook_dead_letters", column: "tenant_id" },
  { table: "webhook_endpoints", column: "tenant_id" },
  { table: "domain_events", column: "tenant_id" },

  // ---- Onboarding / identity (tenants registry last) ----
  { table: "email_verifications", column: "tenant_id" },
  { table: "wallet_identities", column: "tenant_id" },
  { table: "users", column: "tenant_id" },
  // tenants itself uses `id` as the tenant key, not tenant_id/owner_id.
  // Handled separately below to preserve the column-shape invariant.
];

/**
 * Tables intentionally NOT deleted. The audit chain backs the
 * verify-without-trusting-Brain promise; GDPR Article 17(3)(b) permits
 * retention for the establishment or defence of legal claims.
 */
export const PRESERVED_TABLES: ReadonlySet<string> = new Set([
  "audit_events",
  "audit_anchors",
]);

export interface TenantDeletionDeps {
  /** A privileged Pool (BYPASSRLS) so cross-tenant rows are reachable. */
  privilegedPool: Pool;
  audit: AuditEmitter;
}

export class TenantDeletionService {
  public constructor(private readonly deps: TenantDeletionDeps) {}

  public async deleteTenant(
    ctx: ServiceCallContext,
    targetTenantId: string,
  ): Promise<TenantDeletionResult> {
    const client = await this.deps.privilegedPool.connect();
    const deletedRows: Record<string, number> = {};
    let totalRows = 0;
    try {
      await client.query("BEGIN");
      for (const { table, column } of TENANT_SCOPED_TABLES) {
        const res = await client.query(`DELETE FROM ${table} WHERE ${column} = $1`, [
          targetTenantId,
        ]);
        const count = res.rowCount ?? 0;
        deletedRows[table] = count;
        totalRows += count;
      }
      // tenants is keyed by `id` (it IS the tenant registry), not tenant_id.
      // Delete it last so children referencing tenants don't FK-violate.
      const tenantsRes = await client.query(`DELETE FROM tenants WHERE id = $1`, [
        targetTenantId,
      ]);
      const tenantsCount = tenantsRes.rowCount ?? 0;
      deletedRows.tenants = tenantsCount;
      totalRows += tenantsCount;
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    // Emit the tombstone audit event AFTER the transaction commits so the
    // chain reflects only successful deletions.
    await this.deps.audit.emit({
      tenantId: targetTenantId,
      layer: "audit",
      actor: ctx.actor,
      action: "tenant.deleted",
      inputs: { tenant_id: targetTenantId, requested_by: ctx.actor },
      outputs: {
        total_rows_deleted: totalRows,
        per_table_counts: deletedRows,
        // Explicit non-deletion: audit_events + audit_anchors preserved
        // under GDPR legitimate-interest carveout (financial integrity).
        preserved: ["audit_events", "audit_anchors"],
      },
    });

    return {
      tenantId: targetTenantId,
      deletedRows,
      totalRows,
    };
  }
}
