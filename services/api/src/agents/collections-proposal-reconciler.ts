import type { Pool } from "pg";
import {
  startManagedInterval,
  withTenantScope,
  type AuditEmitter,
  type ManagedWorker,
  type MetricsEmitter,
  type TenantScopedClient,
} from "@brain/shared";
import {
  assertProposalTransition,
  findPendingCollectionsProposalForInvoice,
  lockCollectionsProposalForInvoice,
  outcomeToStatus,
  refreshCollectionsProposal,
  type AgentServiceDeps,
  type ProposalRow,
} from "@brain/execution";
import { refreshCollectionsActionDaysOverdue } from "@brain/internal-agents";

/**
 * Collections proposal reconciler (#534/#535).
 *
 * A pending Collections proposal is otherwise only refreshed as a side
 * effect of `AgentService.propose()`, which only runs when the overdue
 * scanner's forward sweep re-triggers a FULL successful agent run for the
 * same invoice. That coupling breaks whenever the invoice never appears in
 * `ledger_invoices` at all (#534), or whenever `AgentRunService.run` takes
 * any of its several early terminal returns AFTER claiming the scanner's 24h
 * cooldown but BEFORE reaching `proposeAction` (missing handler/action,
 * missing evidence, `notify_only`/`reject` execution mode, payload
 * validation failure) (#535). Every one of those burns the cooldown without
 * touching the proposal, so a persistent condition freezes it for a full day
 * per cycle while the invoice keeps aging.
 *
 * This worker fixes both from the proposal side instead: enumerate pending
 * Collections proposals directly and reconcile each one against the current
 * `ledger_invoices` row, independent of whether an agent run ever succeeds.
 */

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
const DEFAULT_PER_TENANT_BATCH_SIZE = 50;
const DEFAULT_TENANT_BATCH_SIZE = 200;
const RECONCILER_ACTOR = "collections_proposal_reconciler";

// Mirrors ledger_invoices.status values the overdue scanner already treats
// as settled/closed (`collections-overdue-scanner.ts`'s `status NOT IN (...)`
// filter). Kept local rather than shared: this is the ONLY place a
// non-collectible invoice is observed without acting on it (see module doc).
const NON_COLLECTIBLE_STATUSES = new Set(["paid", "cancelled", "disputed"]);

export interface CollectionsProposalReconcilerDeps {
  /** BYPASSRLS pool (brain_tenant_deletion), cross-tenant discovery only. */
  readonly tenantDiscoveryPool: Pool;
  /** brain_app pool: all per-tenant reads/writes go through this, tenant-scoped. */
  readonly appPool: Pool;
  readonly evaluatePolicy: AgentServiceDeps["evaluatePolicy"];
  readonly audit?: AuditEmitter;
  readonly metrics?: MetricsEmitter;
  readonly log?: {
    error(obj: unknown, msg?: string): void;
    warn(obj: unknown, msg?: string): void;
    info?(obj: unknown, msg?: string): void;
  };
}

export interface CollectionsProposalReconcilerOptions {
  readonly intervalMs?: number;
  readonly perTenantBatchSize?: number;
  readonly tenantBatchSize?: number;
  readonly now?: Date;
}

type ReconcileOutcome =
  | { readonly kind: "superseded" }
  | { readonly kind: "refreshed" }
  | { readonly kind: "non_collectible" }
  | { readonly kind: "current" }
  | { readonly kind: "skipped"; readonly reason: string };

export function startCollectionsProposalReconciler(
  deps: CollectionsProposalReconcilerDeps,
  opts: CollectionsProposalReconcilerOptions = {},
): ManagedWorker {
  return startManagedInterval(
    () => runCollectionsProposalReconcileCycle(deps, opts),
    opts.intervalMs ?? DEFAULT_INTERVAL_MS,
    {
      name: "collections-proposal-reconciler",
      runImmediately: false,
      onError: (err) => deps.log?.error({ err }, "collections proposal reconciler failed"),
    },
  );
}

export async function runCollectionsProposalReconcileCycle(
  deps: CollectionsProposalReconcilerDeps,
  opts: CollectionsProposalReconcilerOptions = {},
): Promise<void> {
  const now = opts.now ?? new Date();
  const perTenantBatchSize = opts.perTenantBatchSize ?? DEFAULT_PER_TENANT_BATCH_SIZE;
  const tenantIds = await listTenantsWithPendingCollectionsProposals(
    deps.tenantDiscoveryPool,
    opts.tenantBatchSize ?? DEFAULT_TENANT_BATCH_SIZE,
  );

  let superseded = 0;
  let refreshed = 0;
  let nonCollectible = 0;
  let current = 0;
  const skippedByReason = new Map<string, number>();

  for (const tenantId of tenantIds) {
    const invoiceIds = await withTenantScope(deps.appPool, tenantId, (client) =>
      listPendingCollectionsInvoiceIds(client, perTenantBatchSize),
    );
    for (const invoiceId of invoiceIds) {
      const outcome = await reconcileOne(deps, tenantId, invoiceId, now);
      switch (outcome.kind) {
        case "superseded":
          superseded += 1;
          deps.metrics?.increment("brain.collections.reconcile.superseded.count");
          break;
        case "refreshed":
          refreshed += 1;
          deps.metrics?.increment("brain.collections.reconcile.refreshed.count");
          break;
        case "non_collectible":
          nonCollectible += 1;
          deps.metrics?.increment("brain.collections.reconcile.non_collectible.count");
          break;
        case "current":
          current += 1;
          break;
        case "skipped":
          skippedByReason.set(outcome.reason, (skippedByReason.get(outcome.reason) ?? 0) + 1);
          deps.metrics?.increment("brain.collections.reconcile.skipped.count", {
            reason: outcome.reason,
          });
          break;
      }
    }
  }

  const successUnix = Math.floor(now.getTime() / 1000);
  deps.metrics?.gauge("brain.collections.reconcile.last_success_unixtime", successUnix);
  deps.log?.info?.(
    {
      tenants: tenantIds.length,
      superseded,
      refreshed,
      non_collectible: nonCollectible,
      current,
      skipped: Object.fromEntries(skippedByReason),
    },
    "collections proposal reconcile cycle complete",
  );
}

/** One invoice, fully re-verified and written (if at all) under the same
 *  advisory lock + tenant-scoped transaction AgentService.propose() uses, so
 *  this cannot race the overdue scanner's own refresh. */
async function reconcileOne(
  deps: CollectionsProposalReconcilerDeps,
  tenantId: string,
  invoiceId: string,
  now: Date,
): Promise<ReconcileOutcome> {
  return withTenantScope(deps.appPool, tenantId, async (client) => {
    await lockCollectionsProposalForInvoice(client, tenantId, invoiceId);
    const proposal = await findPendingCollectionsProposalForInvoice(client, invoiceId);
    if (proposal === null) {
      // Raced: resolved, refreshed onto a different row, or already
      // superseded between the tenant's batch listing and this lock.
      return { kind: "skipped", reason: "no_longer_pending" };
    }
    const invoice = await findInvoiceForReconcile(client, invoiceId, now);
    if (invoice === null) {
      await supersedeProposal(deps, client, tenantId, proposal, now);
      return { kind: "superseded" };
    }
    if (!isCollectible(invoice)) {
      // Scope note: a paid/cancelled/disputed or fully-paid invoice is a
      // separate product decision (out of scope for #534/#535). Count it,
      // do not act on it.
      return { kind: "non_collectible" };
    }
    if (invoice.calculated_days_overdue === null) {
      return { kind: "skipped", reason: "missing_due_date" };
    }
    const storedDaysOverdue = readStoredDaysOverdue(proposal.action);
    if (storedDaysOverdue === invoice.calculated_days_overdue) {
      return { kind: "current" };
    }
    return refreshProposal(deps, client, tenantId, proposal, invoice.calculated_days_overdue, now);
  });
}

async function supersedeProposal(
  deps: CollectionsProposalReconcilerDeps,
  client: TenantScopedClient,
  tenantId: string,
  proposal: ProposalRow,
  now: Date,
): Promise<void> {
  assertProposalTransition(proposal.status, "superseded");
  const { rows } = await client.query<ProposalRow>(
    `UPDATE proposals
        SET status = 'superseded',
            superseded_at = $2,
            updated_at = $2
      WHERE id = $1
        AND status = 'pending'
      RETURNING *`,
    [proposal.id, now.toISOString()],
  );
  if (rows[0] === undefined) {
    throw new Error(`collections proposal ${proposal.id} stopped being pending during supersede`);
  }

  await deps.audit?.emit({
    tenantId,
    layer: "agent",
    actor: RECONCILER_ACTOR,
    action: "agent.action.superseded",
    inputs: {
      proposal_id: proposal.id,
      invoice_id: proposal.action["invoice_id"] ?? null,
    },
    outputs: { status: "superseded", reason: "source_invoice_missing" },
    beforeState: { id: proposal.id, status: proposal.status, action: proposal.action },
    afterState: { id: proposal.id, status: "superseded" },
    idempotencyKey: `collections-proposal-reconcile:supersede:${proposal.id}`,
  });
}

async function refreshProposal(
  deps: CollectionsProposalReconcilerDeps,
  client: TenantScopedClient,
  tenantId: string,
  proposal: ProposalRow,
  daysOverdue: number,
  now: Date,
): Promise<ReconcileOutcome> {
  const refreshedAction = refreshCollectionsActionDaysOverdue(proposal.action, {
    daysOverdue,
    now,
  });
  const policyResult = await deps.evaluatePolicy(tenantId, refreshedAction);
  const authority = refreshedAction["mode"] === "notify_only" ? "notify_only" : "propose";
  const status = outcomeToStatus(policyResult.outcome, authority);
  if (status !== "pending") {
    // A background sweep must never force a proposal out of pending; that
    // is a decision for the request path (approve/reject), not a reconciler.
    // Leave the row untouched and surface it instead.
    deps.log?.warn(
      {
        tenantId,
        proposalId: proposal.id,
        invoiceId: proposal.action["invoice_id"] ?? null,
        outcome: policyResult.outcome,
        wouldBeStatus: status,
      },
      "collections proposal reconciler skipped a refresh that would leave pending",
    );
    return { kind: "skipped", reason: "policy_outcome_not_pending" };
  }

  const previousDaysOverdue = proposal.action["days_overdue"] ?? null;
  await refreshCollectionsProposal(client, proposal, {
    action: refreshedAction,
    policyVersion: policyResult.policy_version,
    policyDecision: policyResult.outcome,
    policyTrace: policyResult.trace as never,
    requiredApprovers: policyResult.required_approvers,
    status,
  });

  await deps.audit?.emit({
    tenantId,
    layer: "agent",
    actor: RECONCILER_ACTOR,
    action: "agent.action.refreshed",
    ...(policyResult.matched_rule_id !== null
      ? { policyCheckId: policyResult.matched_rule_id }
      : {}),
    outcome: policyResult.outcome,
    inputs: {
      action_kind: String(refreshedAction["kind"] ?? "agent_action"),
      proposal_id: proposal.id,
      invoice_id: proposal.action["invoice_id"] ?? null,
    },
    outputs: {
      status,
      outcome: policyResult.outcome,
      matched_rule_id: policyResult.matched_rule_id,
      required_approvers: policyResult.required_approvers,
      refreshed: true,
      previous_days_overdue: previousDaysOverdue,
      days_overdue: daysOverdue,
    },
  });

  return { kind: "refreshed" };
}

function readStoredDaysOverdue(action: Record<string, unknown>): number | null {
  const raw = action["days_overdue"];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

interface InvoiceReconcileRow {
  readonly status: string;
  readonly collectible_by_amount: boolean;
  readonly calculated_days_overdue: number | null;
}

function isCollectible(invoice: InvoiceReconcileRow): boolean {
  return !NON_COLLECTIBLE_STATUSES.has(invoice.status) && invoice.collectible_by_amount;
}

async function findInvoiceForReconcile(
  client: TenantScopedClient,
  invoiceId: string,
  now: Date,
): Promise<InvoiceReconcileRow | null> {
  const { rows } = await client.query<InvoiceReconcileRow>(
    `SELECT status,
            (amount_paid < amount_due) AS collectible_by_amount,
            CASE
              WHEN due_date IS NOT NULL
                THEN GREATEST(FLOOR(EXTRACT(EPOCH FROM ($2::timestamptz - due_date)) / 86400), 1)::int
              ELSE NULL
            END AS calculated_days_overdue
       FROM ledger_invoices
      WHERE id = $1
      LIMIT 1`,
    [invoiceId, now.toISOString()],
  );
  return rows[0] ?? null;
}

async function listTenantsWithPendingCollectionsProposals(
  pool: Pool,
  limit: number,
): Promise<string[]> {
  const { rows } = await pool.query<{ tenant_id: string }>(
    `SELECT DISTINCT tenant_id
       FROM proposals
      WHERE proposing_agent = 'collections'
        AND status = 'pending'
        AND action->>'type' = 'collections'
        AND NULLIF(action->>'invoice_id', '') IS NOT NULL
      ORDER BY tenant_id
      LIMIT $1`,
    [limit],
  );
  return rows.map((row) => row.tenant_id);
}

async function listPendingCollectionsInvoiceIds(
  client: TenantScopedClient,
  limit: number,
): Promise<string[]> {
  const { rows } = await client.query<{ invoice_id: string }>(
    `SELECT action->>'invoice_id' AS invoice_id
       FROM proposals
      WHERE proposing_agent = 'collections'
        AND status = 'pending'
        AND action->>'type' = 'collections'
        AND NULLIF(action->>'invoice_id', '') IS NOT NULL
      ORDER BY created_at ASC, id ASC
      LIMIT $1`,
    [limit],
  );
  return rows.map((row) => row.invoice_id);
}
