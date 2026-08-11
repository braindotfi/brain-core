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
 *
 * The per-tenant batch is a WORK LIST, not a scan window: the "does this row
 * need action" filter (invoice missing, or collectible + overdue + drifted
 * `days_overdue`) runs in the tenant-scoped SQL itself, so `current` and
 * `non_collectible` rows never occupy a batch slot. Every selected row leaves
 * the work list once processed, so the batch cap bounds work per cycle
 * without starving anything behind it.
 */

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
const DEFAULT_PER_TENANT_BATCH_SIZE = 50;
const DEFAULT_TENANT_BATCH_SIZE = 200;
const RECONCILER_ACTOR = "collections_proposal_reconciler";

// Mirrors ledger_invoices.status values the overdue scanner already treats
// as settled/closed (`collections-overdue-scanner.ts`'s `status NOT IN (...)`
// filter). Kept local rather than shared: this is the ONLY place a
// non-collectible invoice is observed without acting on it (see module doc).
// The literal `'paid', 'cancelled', 'disputed'` list is duplicated in the
// work-list and non-collectible-count SQL below; keep all three in sync.
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
    const workList = await withTenantScope(deps.appPool, tenantId, (client) =>
      listCollectionsWorkList(client, perTenantBatchSize, now),
    );
    if (workList.totalMatching > workList.invoiceIds.length) {
      const omittedCount = workList.totalMatching - workList.invoiceIds.length;
      deps.log?.warn(
        {
          tenantId,
          perTenantBatchSize,
          totalMatching: workList.totalMatching,
          omittedCount,
        },
        "collections proposal reconciler hit per-tenant batch cap",
      );
      deps.metrics?.increment(
        "brain.collections.reconcile.dropped.count",
        { reason: "batch_cap" },
        omittedCount,
      );
    }

    // Rows that already resolved to non_collectible no longer enter the work
    // list at all, so count them with one cheap aggregate instead of a
    // per-row lock/re-verify cycle.
    const nonCollectibleForTenant = await withTenantScope(deps.appPool, tenantId, (client) =>
      countNonCollectiblePendingCollectionsProposals(client, now),
    );
    if (nonCollectibleForTenant > 0) {
      nonCollectible += nonCollectibleForTenant;
      deps.metrics?.increment(
        "brain.collections.reconcile.non_collectible.count",
        undefined,
        nonCollectibleForTenant,
      );
    }

    for (const invoiceId of workList.invoiceIds) {
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
          // Rare here: the work list is unlocked and can be stale, so a row
          // it selected may have resolved to non_collectible by the time the
          // advisory lock is taken. The aggregate above already counts the
          // steady-state case.
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
    if (invoice.due_date === null) {
      return { kind: "skipped", reason: "missing_due_date" };
    }
    if (invoice.calculated_days_overdue === null) {
      // due_date is set but is not in the past: a corrected or renegotiated
      // term, not drift. Not overdue means not collections-actionable;
      // count it, do not refresh it to a fabricated "1 day overdue".
      return { kind: "non_collectible" };
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
    // Leave action/status/policy untouched and surface it instead. This is
    // the one outcome that can keep matching the work-list's drift filter
    // cycle over cycle, so bump only `updated_at` (a content-preserving
    // "examined at" touch) to push it to the back of the work list's
    // `updated_at ASC` order. That bounds its impact to at most one batch
    // slot per cycle per such row, rotating the rest of a saturated tenant's
    // work list forward instead of resubmitting this row every time.
    await touchProposalReconcileAttempt(client, proposal.id, now);
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

/** Content-preserving "examined at" bump for a row the reconciler cannot
 *  write for real (see `refreshProposal`'s `policy_outcome_not_pending`
 *  path). Only `updated_at` moves; action/status/policy are untouched. */
async function touchProposalReconcileAttempt(
  client: TenantScopedClient,
  proposalId: string,
  now: Date,
): Promise<void> {
  await client.query(`UPDATE proposals SET updated_at = $2 WHERE id = $1 AND status = 'pending'`, [
    proposalId,
    now.toISOString(),
  ]);
}

interface InvoiceReconcileRow {
  readonly status: string;
  readonly collectible_by_amount: boolean;
  readonly due_date: string | null;
  readonly calculated_days_overdue: number | null;
}

function isCollectible(invoice: InvoiceReconcileRow): boolean {
  return !NON_COLLECTIBLE_STATUSES.has(invoice.status) && invoice.collectible_by_amount;
}

/** Guarded the same way the overdue scanner's own selection query is
 *  (`due_date < now`): `calculated_days_overdue` is only computed when the
 *  invoice is actually overdue, so a due date corrected or renegotiated into
 *  the future never floors to a fabricated "1 day overdue" (see
 *  `reconcileOne`'s `calculated_days_overdue === null` branch). */
async function findInvoiceForReconcile(
  client: TenantScopedClient,
  invoiceId: string,
  now: Date,
): Promise<InvoiceReconcileRow | null> {
  const { rows } = await client.query<InvoiceReconcileRow>(
    `SELECT status,
            (amount_paid < amount_due) AS collectible_by_amount,
            due_date::text AS due_date,
            CASE
              WHEN due_date IS NOT NULL AND due_date < $2::timestamptz
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

interface CollectionsWorkList {
  readonly invoiceIds: string[];
  /** Total rows matching the work-list filter before the LIMIT, so the
   *  caller can detect and warn on a saturated per-tenant batch. */
  readonly totalMatching: number;
}

/** The work list: only pending Collections proposals that actually need
 *  action (invoice missing, or collectible + overdue + drifted
 *  `days_overdue`). `reconcileOne` re-verifies every row under the advisory
 *  lock regardless; this is an unlocked pre-filter, not the source of truth.
 *
 *  Ordered `updated_at ASC NULLS FIRST, id ASC` (not `created_at`) so a row
 *  this cycle actually wrote moves to the back next cycle; a row that
 *  matches every cycle but is never written (`policy_outcome_not_pending`,
 *  see `refreshProposal`) is explicitly touched there to get the same
 *  rotation, bounding it to one batch slot per cycle instead of
 *  monopolizing the front of the list forever. */
async function listCollectionsWorkList(
  client: TenantScopedClient,
  limit: number,
  now: Date,
): Promise<CollectionsWorkList> {
  const { rows } = await client.query<{
    invoice_id: string;
    total_matching: number | string;
  }>(
    `SELECT p.action->>'invoice_id' AS invoice_id,
            COUNT(*) OVER() AS total_matching
       FROM proposals p
       LEFT JOIN ledger_invoices i ON i.id = p.action->>'invoice_id'
      WHERE p.proposing_agent = 'collections'
        AND p.status = 'pending'
        AND p.action->>'type' = 'collections'
        AND NULLIF(p.action->>'invoice_id', '') IS NOT NULL
        AND (
          i.id IS NULL
          OR (
            i.status NOT IN ('paid', 'cancelled', 'disputed')
            AND i.amount_paid < i.amount_due
            AND i.due_date IS NOT NULL
            AND i.due_date < $2::timestamptz
            AND (p.action->'days_overdue') IS DISTINCT FROM to_jsonb(
              GREATEST(FLOOR(EXTRACT(EPOCH FROM ($2::timestamptz - i.due_date)) / 86400), 1)::int
            )
          )
        )
      ORDER BY p.updated_at ASC NULLS FIRST, p.id ASC
      LIMIT $1`,
    [limit, now.toISOString()],
  );
  return {
    invoiceIds: rows.map((row) => row.invoice_id),
    totalMatching: rows.length > 0 ? normalizeCount(rows[0]?.total_matching, rows.length) : 0,
  };
}

/** Cheap per-tenant aggregate for proposals whose invoice exists but is not
 *  actionable (paid/cancelled/disputed/fully paid, or no longer overdue).
 *  These never enter the work list, so they are counted here instead of
 *  per row. Deliberately excludes invoices with a null `due_date`: those
 *  never enter the work list either (nothing computable to drift-check),
 *  so they are neither counted as non-collectible nor reconciled; that is
 *  an accepted, unchanged-from-before gap for a case with no test coverage
 *  today, not a new regression from this fix. */
async function countNonCollectiblePendingCollectionsProposals(
  client: TenantScopedClient,
  now: Date,
): Promise<number> {
  const { rows } = await client.query<{ count: number | string }>(
    `SELECT COUNT(*) AS count
       FROM proposals p
       JOIN ledger_invoices i ON i.id = p.action->>'invoice_id'
      WHERE p.proposing_agent = 'collections'
        AND p.status = 'pending'
        AND p.action->>'type' = 'collections'
        AND NULLIF(p.action->>'invoice_id', '') IS NOT NULL
        AND (
          i.status IN ('paid', 'cancelled', 'disputed')
          OR i.amount_paid >= i.amount_due
          OR (i.due_date IS NOT NULL AND i.due_date >= $1::timestamptz)
        )`,
    [now.toISOString()],
  );
  return normalizeCount(rows[0]?.count, 0);
}

function normalizeCount(value: number | string | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}
