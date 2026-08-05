/**
 * Tenant deletion service (GDPR right-to-erasure).
 *
 * Walks every tenant-scoped table across the six layers and deletes rows for
 * the target tenant. Runs in a single transaction under the tenant-deletion
 * BYPASSRLS role so cross-tenant access barriers do not block cleanup.
 * BYPASSRLS is retained because the service must erase rows after the tenant
 * request scope is ending, but every DELETE is built by tenantDeleteStatement,
 * which rejects statements without the exact tenant predicate shape.
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
 * Blob cleanup (Raw artifact storage). The §3 Layer-1 immutability promise
 * forbids in-band hard-delete via the BlobAdapter (no `purge` method exists).
 * Tenant deletion therefore CANNOT, on its own, remove the bytes a user
 * uploaded into Azure Blob storage. To stay honest with the GDPR Article 17
 * claim, this service:
 *   1. Selects every `raw_artifacts.blob_uri` for the tenant BEFORE the DELETE.
 *   2. Includes the URI list in the response payload AND in the
 *      `tenant.deleted` audit event under `blob_uris_pending_purge`.
 *   3. Returns `blob_artifact_count` alongside the row counts.
 * An operator (or a future scheduled purge job) must run a separate pass
 * against those URIs to satisfy Article 17 fully. The runbook for this is
 * tracked in docs/rollback.md.
 *
 * TODO(brain-gdpr): wire a privileged hard-delete path on BlobAdapter that
 * is callable only from this service. The architectural tension between §3
 * Layer-1 immutability ("Raw is the source of truth, never mutated") and
 * Article 17 ("the user can demand erasure") needs an explicit carveout in
 * Brain_Engineering_Standards.md §3 before that ships.
 */

import type { Pool } from "pg";
import type { AuditEmitter, AuditEventInput, ServiceCallContext } from "@brain/shared";
import { brainError } from "@brain/shared";
import { enqueueBlobPurgeJob } from "./blob-purge-repo.js";
import { enqueueAuditOutbox } from "./blob-purge-audit-outbox.js";

export interface TenantDeletionResult {
  tenantId: string;
  deletedRows: Record<string, number>;
  totalRows: number;
  /** Count of `raw_artifacts` rows that referenced a blob — the number of
   *  Azure Blob objects an operator must purge out-of-band. */
  blobArtifactCount: number;
  /** Every `blob_uri` from the deleted `raw_artifacts` rows. Operators run
   *  the purge job against this list to satisfy GDPR Article 17 fully. */
  blobUrisPendingPurge: ReadonlyArray<string>;
  /** The `tenant_blob_purge_jobs` row enqueued for the privileged worker to
   *  erase the Raw bytes (RFC 0003). `null` when the tenant uploaded no blobs. */
  blobPurgeJobId: string | null;
}

/**
 * Tables to wipe, in deletion order. Children before parents where a foreign
 * key exists. The registry-derived test in service.test.ts scans every
 * migration in services/{layer}/migrations and asserts each tenant-scoped table
 * is either listed here OR in PRESERVED_TABLES — so a new migration that
 * adds a tenant-scoped table without updating this list fails CI.
 */
export const TENANT_SCOPED_TABLES: ReadonlyArray<{
  table: string;
  column: "owner_id" | "tenant_id" | "brain_tenant_id";
}> = [
  // ---- Layer 1: Raw ----
  { table: "raw_parsed", column: "tenant_id" },
  { table: "raw_interpretation_log", column: "tenant_id" },
  { table: "raw_plaid_items", column: "tenant_id" },
  { table: "extraction_jobs", column: "tenant_id" },
  { table: "raw_artifacts", column: "tenant_id" },
  // Sync checkpoints before their connection rows (soft source_id reference).
  { table: "raw_sync_partitions", column: "tenant_id" },
  { table: "raw_source_sync_jobs", column: "tenant_id" },
  { table: "raw_sources", column: "tenant_id" },
  { table: "raw_tenant_settings", column: "tenant_id" },

  // ---- Layer 1.5: Canonical domain (ingestion architecture §12, Phase 5) ----
  // Children before parents (journal_line FK -> journal_entry).
  { table: "canonical_journal_line", column: "tenant_id" },
  { table: "canonical_journal_entry", column: "tenant_id" },
  { table: "canonical_gl_account", column: "tenant_id" },
  { table: "canonical_projection_log", column: "tenant_id" },
  // Ledger connector domain: transactions reference accounts.
  { table: "canonical_transaction", column: "tenant_id" },
  { table: "canonical_account", column: "tenant_id" },
  // AP/AR: obligation references counterparty, so delete obligation first.
  { table: "canonical_obligation", column: "tenant_id" },
  { table: "canonical_counterparty", column: "tenant_id" },

  // ---- Layer 2: Ledger ----
  // GL-account projection of canonical (soft ref to canonical_gl_account; no FK).
  { table: "ledger_gl_accounts", column: "tenant_id" },
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
  { table: "ledger_projection_quarantine", column: "tenant_id" },

  // ---- Layer 3: Wiki ----
  { table: "wiki_question_intent_usage", column: "tenant_id" },
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
  { table: "agent_trigger_cooldowns", column: "tenant_id" },
  { table: "agent_runs", column: "tenant_id" },
  { table: "agent_routing_decisions", column: "tenant_id" },
  { table: "agent_idempotency_keys", column: "tenant_id" },
  { table: "execution_outbox", column: "tenant_id" },
  { table: "executions", column: "tenant_id" },
  { table: "approvals", column: "tenant_id" },
  { table: "proposals", column: "tenant_id" },
  { table: "production_agent_tokens", column: "tenant_id" },
  { table: "agents", column: "tenant_id" },

  // ---- Surface gateway (Slack / Teams / email approval surfaces) ----
  // services/surface-gateway/migrations. None of these declare a foreign key
  // to `tenants`, so before this block a deleted tenant's surface rows were
  // silently ORPHANED rather than FK-erroring the transaction — the deletion
  // reported success while Slack/Teams install tokens, external identities and
  // proposal payloads survived. Ordering among them is arbitrary (no FKs
  // between them either).
  { table: "surface_delivered_refs", column: "tenant_id" },
  { table: "surface_decisions", column: "tenant_id" },
  { table: "surface_proposals", column: "tenant_id" },
  { table: "surface_external_identities", column: "tenant_id" },
  { table: "surface_slack_install_nonces", column: "tenant_id" },
  { table: "surface_slack_installations", column: "tenant_id" },
  { table: "surface_teams_conversation_refs", column: "tenant_id" },
  // The only table in the repo whose tenant key is not tenant_id/owner_id:
  // it joins a Brain tenant to an AAD tenant, so both columns are "tenant ids"
  // and the Brain one is qualified (services/surface-gateway/migrations/0005).
  { table: "surface_teams_installations", column: "brain_tenant_id" },
  { table: "surface_email_recipients", column: "tenant_id" },
  { table: "surface_email_routes", column: "tenant_id" },
  { table: "surface_email_domains", column: "tenant_id" },
  // surface_slack_retries is deliberately absent: it has no tenant column and
  // stores only a SHA-256 of a Slack signature+body (one-way, no payload to
  // recover), so it holds nothing to erase.

  // ---- Layer 6: Audit (metadata only; events + anchors preserved) ----
  { table: "webhook_delivery_receipts", column: "tenant_id" },
  { table: "webhook_dead_letters", column: "tenant_id" },
  { table: "webhook_endpoints", column: "tenant_id" },
  { table: "domain_events", column: "tenant_id" },

  // ---- Auth (OAuth authorization server, services/auth/migrations/0001) ----
  // No FK relationships between the three (see the migration header for why);
  // order is arbitrary among them. oauth_clients is deliberately absent: it
  // has no tenant_id column (DCR clients register before any tenant exists)
  // and carries zero authority until a consent grant binds it to a tenant.
  { table: "oauth_authorization_codes", column: "tenant_id" },
  { table: "oauth_refresh_tokens", column: "tenant_id" },
  { table: "oauth_consent_grants", column: "tenant_id" },

  // ---- Onboarding / identity (tenants registry last) ----
  { table: "governance_report_snapshots", column: "tenant_id" },
  { table: "assistant_questions", column: "tenant_id" },
  { table: "tenant_export_jobs", column: "tenant_id" },
  { table: "email_verifications", column: "tenant_id" },
  { table: "wallet_identities", column: "tenant_id" },
  { table: "session_refresh_tokens", column: "tenant_id" },
  { table: "member_invites", column: "tenant_id" },
  { table: "api_keys", column: "tenant_id" },
  { table: "member_identity_links", column: "tenant_id" },
  { table: "members", column: "tenant_id" },
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
  // RFC 0003: the blob purge queue must SURVIVE the deletion — a privileged
  // worker drains it after the tenant rows are gone, and the row stands as the
  // on-record proof that Article 17 erasure was enqueued.
  "tenant_blob_purge_jobs",
  // RFC 0003 (P2 #1): the purge audit outbox likewise survives — it carries the
  // lifecycle audit intents the worker delivers after the tenant rows are gone.
  "tenant_blob_purge_audit_outbox",
  // Codex 307161b P1 #2: integrity findings are forensic records ABOUT the
  // preserved, append-only audit log; they are retained with it, not erased.
  "audit_integrity_findings",
]);

export interface TenantDeletionDeps {
  /** A privileged Pool (BYPASSRLS) so cross-tenant rows are reachable. */
  privilegedPool: Pool;
  audit: AuditEmitter;
}

export type TenantDeletionPredicateColumn = "owner_id" | "tenant_id" | "brain_tenant_id" | "id";

export function assertTenantDeleteStatement(
  sql: string,
  column: TenantDeletionPredicateColumn,
): void {
  const normalized = sql.replace(/\s+/g, " ").trim();
  const re = new RegExp(`^DELETE FROM [a-z_][a-z0-9_]* WHERE ${column} = \\$1$`, "i");
  if (!re.test(normalized)) {
    throw new Error(`tenant deletion DELETE must include exact ${column} = $1 predicate`);
  }
}

export function tenantDeleteStatement(
  table: string,
  column: TenantDeletionPredicateColumn,
): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) {
    throw new Error(`invalid tenant deletion table name: ${table}`);
  }
  const sql = `DELETE FROM ${table} WHERE ${column} = $1`;
  assertTenantDeleteStatement(sql, column);
  return sql;
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
    let blobUrisPendingPurge: string[] = [];
    let blobPurgeJobId: string | null = null;
    // Built inside the transaction (once the deletes have run) and reused for the
    // post-commit best-effort emit. Idempotency keys are stable per tenant.
    let deletedOutputs: Record<string, unknown> = {};
    let purgeRequestedOutputs: Record<string, unknown> | null = null;
    const deletedEventKey = `${targetTenantId}:tenant.deleted`;
    const purgeRequestedEventKey = `${targetTenantId}:tenant_blob.purge_requested`;
    try {
      await client.query("BEGIN");
      // F2: the route only ever checked principal_type=user + self-tenant,
      // with no scope check and no members-row check, so ANY active member
      // -- including a viewer -- could erase the entire tenant. Require the
      // caller to be a live, active admin member of the tenant being
      // deleted (the same authority level member deactivation already
      // requires), checked in THIS transaction rather than a separate
      // connection: a caller demoted or deactivated between the check and
      // the deletes must not still slip through, and this way there is one
      // atomic all-or-nothing transaction, not a check-then-act gap.
      const memberRes = await client.query<{
        role: "admin" | "approver" | "viewer";
        active: boolean;
        status: "invited" | "active" | "deactivated";
      }>(`SELECT role, active, status FROM members WHERE id = $1 AND tenant_id = $2 LIMIT 1`, [
        ctx.actor,
        targetTenantId,
      ]);
      const member = memberRes.rows[0];
      if (member === undefined || !member.active || member.status !== "active") {
        throw brainError("tenant_access_denied", "actor_unresolved", {
          details: { reason: "actor_unresolved" },
        });
      }
      if (member.role !== "admin") {
        throw brainError("auth_scope_insufficient", "admin member required");
      }
      // Snapshot the blob_uri list BEFORE the DELETE wipes the rows. These
      // URIs are what an operator must purge out-of-band to satisfy GDPR
      // Article 17 fully (Layer-1 immutability blocks in-band hard delete).
      const blobRes = await client.query(
        `SELECT blob_uri FROM raw_artifacts WHERE tenant_id = $1 AND blob_uri IS NOT NULL`,
        [targetTenantId],
      );
      blobUrisPendingPurge = (blobRes.rows as Array<{ blob_uri: string }>).map((r) => r.blob_uri);
      // RFC 0003: enqueue the durable blob-purge job IN this transaction, before
      // the rows are wiped, so the hand-off to the privileged worker is atomic
      // with the deletion (a rolled-back deletion leaves no orphan job). Gated
      // on there being blobs to erase. The job lives in PRESERVED_TABLES, so it
      // survives the deletes below.
      if (blobUrisPendingPurge.length > 0) {
        blobPurgeJobId = await enqueueBlobPurgeJob(client, {
          tenantId: targetTenantId,
          blobPrefix: `${targetTenantId}/`,
          blobArtifactCount: blobUrisPendingPurge.length,
        });
      }
      for (const { table, column } of TENANT_SCOPED_TABLES) {
        const res = await client.query(tenantDeleteStatement(table, column), [targetTenantId]);
        const count = res.rowCount ?? 0;
        deletedRows[table] = count;
        totalRows += count;
      }
      // tenants is keyed by `id` (it IS the tenant registry), not tenant_id.
      // Delete it last so children referencing tenants don't FK-violate.
      const tenantsRes = await client.query(tenantDeleteStatement("tenants", "id"), [
        targetTenantId,
      ]);
      const tenantsCount = tenantsRes.rowCount ?? 0;
      deletedRows.tenants = tenantsCount;
      totalRows += tenantsCount;

      // Enqueue the deletion audit INTENTS in this same transaction (review P1):
      // a committed deletion always has a durable audit record, even if the
      // immediate emit after commit fails or the process dies. The blob-purge
      // worker delivers these from the outbox (idempotency-keyed, so the
      // immediate emit below cannot produce a duplicate).
      deletedOutputs = {
        total_rows_deleted: totalRows,
        per_table_counts: deletedRows,
        // Explicit non-deletion: audit_events + audit_anchors preserved under the
        // GDPR legitimate-interest carveout (financial integrity).
        preserved: ["audit_events", "audit_anchors"],
        // Blob bytes are NOT removed by this transaction (§3 Layer-1 immutability).
        blob_artifact_count: blobUrisPendingPurge.length,
        blob_uris_pending_purge: blobUrisPendingPurge,
        blob_purge_job_id: blobPurgeJobId,
      };
      await enqueueAuditOutbox(client, {
        tenantId: targetTenantId,
        action: "tenant.deleted",
        payload: deletedOutputs,
        eventKey: deletedEventKey,
        actor: ctx.actor,
        inputs: { tenant_id: targetTenantId, requested_by: ctx.actor },
      });
      if (blobPurgeJobId !== null) {
        purgeRequestedOutputs = {
          tenant_blob_purge_job_id: blobPurgeJobId,
          blob_prefix: `${targetTenantId}/`,
          blob_artifact_count: blobUrisPendingPurge.length,
        };
        await enqueueAuditOutbox(client, {
          jobId: blobPurgeJobId,
          tenantId: targetTenantId,
          action: "tenant_blob.purge_requested",
          payload: purgeRequestedOutputs,
          eventKey: purgeRequestedEventKey,
          actor: ctx.actor,
          inputs: { tenant_id: targetTenantId, requested_by: ctx.actor },
        });
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    // Best-effort immediate emit for fast audit visibility. Idempotency-keyed to
    // the outbox event_key, so the worker's later delivery finds this event and
    // does NOT duplicate it. A failure here does NOT fail the already-committed
    // deletion — the durable outbox intent above guarantees eventual delivery.
    await this.emitBestEffort({
      tenantId: targetTenantId,
      layer: "audit",
      actor: ctx.actor,
      action: "tenant.deleted",
      inputs: { tenant_id: targetTenantId, requested_by: ctx.actor },
      outputs: deletedOutputs,
      idempotencyKey: deletedEventKey,
    });
    if (purgeRequestedOutputs !== null) {
      await this.emitBestEffort({
        tenantId: targetTenantId,
        layer: "audit",
        actor: ctx.actor,
        action: "tenant_blob.purge_requested",
        inputs: { tenant_id: targetTenantId, requested_by: ctx.actor },
        outputs: purgeRequestedOutputs,
        idempotencyKey: purgeRequestedEventKey,
      });
    }

    return {
      tenantId: targetTenantId,
      deletedRows,
      totalRows,
      blobArtifactCount: blobUrisPendingPurge.length,
      blobUrisPendingPurge,
      blobPurgeJobId,
    };
  }

  /**
   * Emit an audit event without letting a failure propagate: the deletion has
   * already committed and its audit intent is durably enqueued, so an audit
   * outage must not turn a successful deletion into an error response. The
   * outbox worker delivers the durable intent regardless.
   */
  private async emitBestEffort(event: AuditEventInput): Promise<void> {
    try {
      await this.deps.audit.emit(event);
    } catch (err) {
      console.warn(
        "[tenant-deletion] immediate audit emit failed; the outbox will deliver it",
        err,
      );
    }
  }
}
