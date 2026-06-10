/**
 * Execution outbox worker (H-04).
 *
 * The async half of the durable money-mover. `PaymentIntentService.execute`
 * enqueues a `pending` outbox row (atomic with approved → dispatching); this
 * worker drains the queue: claim → dispatch the rail → validate + persist the
 * receipt → emit the §6 audit-after → settle the intent (dispatching → executed)
 * via PaymentIntentService.completeExecution.
 *
 * §6 invariant. This file is the ONLY place outside PaymentIntentService allowed
 * to dispatch a rail (scripts/check-gate-bypass.mjs allowlists it). The license
 * is conditional: it dispatches ONLY rows drained from execution_outbox, and a
 * row only lands there AFTER `execute` ran the full gate and emitted audit-before
 * (whose id rides on the row). The worker never transitions a PaymentIntent to
 * `executed` itself — it calls back into PaymentIntentService, which owns that
 * transition. So "no money moves without the gate" still holds.
 *
 * Connection model. `claimNext` / `reclaimStale` / the outbox `mark*` calls are
 * cross-tenant (one global worker drains every tenant), so they run on a
 * `brain_privileged` (BYPASSRLS) connection — supplied by the injected
 * `withPrivileged`. The per-row settle re-enters the tenant scope inside
 * PaymentIntentService.completeExecution. The injected shape keeps the control
 * flow unit-testable; the real FOR UPDATE SKIP LOCKED claim, the crash-injection
 * recovery, and the concurrent-claim race require Postgres and are covered by an
 * integration test (blocked in this sandbox; see worker.test.ts SANDBOX NOTE).
 */

import {
  newExecutionId,
  startManagedInterval,
  type AuditEmitter,
  type ManagedWorker,
  type ServiceCallContext,
  type TenantScopedClient,
} from "@brain/shared";
import {
  MAX_DISPATCH_ATTEMPTS,
  MAX_TOTAL_DISPATCH_ATTEMPTS,
  type OutboxService,
  type OutboxRow,
} from "./OutboxService.js";
import type { RailRegistry } from "../rails/stubs.js";
import { permanentFailureReason } from "../rails/permanent-failure.js";
import { railKeyForActionType, validateRailReceipt } from "../rails/receipts.js";

/** Query surface for the cross-tenant (privileged) outbox operations. */
type OutboxClient = Pick<TenantScopedClient, "query">;

/**
 * The slice of PaymentIntentService the worker calls back into. Defined
 * structurally so the worker can be tested with a fake and so this module does
 * not need the full service at type-check time.
 */
export interface OutboxExecutor {
  completeExecution(
    ctx: ServiceCallContext,
    args: {
      paymentIntentId: string;
      executionId: string;
      rail: string;
      railReceipt: Record<string, unknown>;
      idempotencyKey: string;
    },
  ): Promise<void>;
  failExecution(ctx: ServiceCallContext, args: { paymentIntentId: string }): Promise<void>;
}

export interface OutboxWorkerDeps {
  outbox: OutboxService;
  rails: RailRegistry;
  executor: OutboxExecutor;
  audit: AuditEmitter;
  /** Runs `fn` on a privileged (cross-tenant) DB client. */
  withPrivileged: <T>(fn: (client: OutboxClient) => Promise<T>) => Promise<T>;
  /** Stable id for this worker process (recorded in locked_by). */
  workerId: string;
}

/** Per-row outcome (also the cycle tally keys). */
export type RowOutcome = "settled" | "retrying" | "reconciling" | "failed";

export interface CycleResult {
  claimed: number;
  reclaimed: number;
  settled: number;
  retrying: number;
  reconciling: number;
  /** Rows terminally failed on a deterministic (permanent) rail rejection. */
  failed: number;
}

/** System ServiceCallContext for the worker acting inside a row's tenant. */
function ctxForRow(row: OutboxRow, workerId: string): ServiceCallContext {
  return { tenantId: row.tenant_id, actor: workerId, requestId: `outbox:${row.id}` };
}

/**
 * Run one drain cycle: recover stale claims, claim a batch, process each row.
 * `staleSeconds` is the lock age after which a `dispatching` row is presumed
 * orphaned by a dead worker and returned to `pending`.
 */
export async function runOutboxCycle(
  deps: OutboxWorkerDeps,
  opts: { limit?: number; staleSeconds?: number } = {},
): Promise<CycleResult> {
  const limit = opts.limit ?? 10;
  const staleSeconds = opts.staleSeconds ?? 300;

  const reclaimed = await deps.withPrivileged((c) => deps.outbox.reclaimStale(c, staleSeconds));
  const rows = await deps.withPrivileged((c) => deps.outbox.claimNext(c, deps.workerId, limit));

  const tally: CycleResult = {
    claimed: rows.length,
    reclaimed: reclaimed.length,
    settled: 0,
    retrying: 0,
    reconciling: 0,
    failed: 0,
  };
  for (const row of rows) {
    const outcome = await processClaimedRow(deps, row);
    tally[outcome] += 1;
  }
  return tally;
}

/**
 * Process a single claimed (`dispatching`) row. Dispatches the rail; on a clean
 * receipt it emits audit-after and settles the intent; on a dispatch error it
 * retries (up to {@link MAX_DISPATCH_ATTEMPTS}) then escalates to `reconciling`;
 * a post-dispatch receipt mismatch goes straight to `reconciling` (money may
 * have moved — never auto-fail the intent in that case).
 *
 * Two bounds keep a failing row from hammering the rail forever:
 *  - a dispatch error the rail tagged PERMANENT (a deterministic contract
 *    revert, e.g. ExceedsPerTxCap — see rails/permanent-failure.ts) skips the
 *    retry budget entirely: the revert guarantees nothing moved, so the worker
 *    closes the §6 audit pair with the failure outcome, fails the intent via
 *    PaymentIntentService.failExecution, and parks the row at status=failed;
 *  - everything else backs off exponentially (claim-side window) and stops
 *    for good at {@link MAX_TOTAL_DISPATCH_ATTEMPTS}, where the worker emits
 *    `execution.outbox.exhausted` and the row parks in `reconciling` for ops.
 */
export async function processClaimedRow(
  deps: OutboxWorkerDeps,
  row: OutboxRow,
): Promise<RowOutcome> {
  const ctx = ctxForRow(row, deps.workerId);
  const executionId = newExecutionId();

  // 0 — §6 runtime invariant: refuse to dispatch if audit-before never fired
  // for this row. PaymentIntentService.execute writes audit_before_id atomically
  // with the outbox row, and scripts/check-gate-bypass.mjs forbids any rail
  // dispatch site outside this worker. This is the runtime belt to that
  // commit-time suspender: if a code path ever races around the lint guard, we
  // refuse to move money, mark the row reconciling, and emit a loud audit event
  // so ops sees it immediately. Defence in depth, not a substitute for the gate.
  if (!row.audit_before_id || row.audit_before_id.length === 0) {
    const reason = `§6 invariant violated: outbox row has no audit_before_id; refusing to dispatch`;
    const attempts = await deps.withPrivileged((c) =>
      deps.outbox.markReconciling(c, row.id, reason),
    );
    await emitStuck(deps, row, attempts, reason);
    await maybeEmitExhausted(deps, row, attempts, reason);
    return "reconciling";
  }

  // 1 — dispatch the rail.
  let receipt: Record<string, unknown>;
  try {
    const rail = deps.rails.get(row.rail);
    const result = await rail.dispatch({
      tenantId: row.tenant_id,
      proposalId: row.payment_intent_id,
      executionId,
      action: row.payload,
      idempotencyKey: row.idempotency_key,
    });
    receipt = result.receipt;
  } catch (err) {
    // 1.5 — a PERMANENT dispatch failure (deterministic contract revert) can
    // never succeed on retry; terminal-fail the row + the intent instead of
    // burning the retry budget against a guaranteed revert.
    const permanent = permanentFailureReason(err);
    if (permanent !== null) {
      return await failPermanently(deps, row, ctx, permanent);
    }
    const message = err instanceof Error ? err.message : String(err);
    const attempts = await deps.withPrivileged((c) => deps.outbox.markFailed(c, row.id, message));
    if (attempts >= MAX_DISPATCH_ATTEMPTS) {
      await emitStuck(deps, row, attempts, message);
      await maybeEmitExhausted(deps, row, attempts, message);
      return "reconciling";
    }
    return "retrying";
  }

  // 2 — receipt schema validation (2.4). A dispatched rail that returns a
  // malformed receipt may still have moved money → reconcile, do NOT fail.
  // The action kind is the `kind` field of the canonical payload `execute` stored.
  const actionKind = typeof row.payload.kind === "string" ? row.payload.kind : "";
  const receiptCheck = validateRailReceipt(railKeyForActionType(actionKind), receipt);
  if (!receiptCheck.ok) {
    const reason = `invalid_rail_receipt: missing ${receiptCheck.missing.join(", ")}`;
    const attempts = await deps.withPrivileged((c) =>
      deps.outbox.markReconciling(c, row.id, reason),
    );
    await emitStuck(deps, row, attempts, reason);
    await maybeEmitExhausted(deps, row, attempts, reason);
    return "reconciling";
  }

  // 3 — close the §6 audit-after. The before-event (emitted by the gate) carries
  // the policy_decision_id; this links to it via gate_audit_before so the pair
  // is complete across the async boundary.
  const after = await deps.audit.emit({
    tenantId: row.tenant_id,
    layer: "agent",
    actor: deps.workerId,
    action: "payment_intent.execute.after",
    inputs: {
      payment_intent_id: row.payment_intent_id,
      rail: row.rail,
      execution_id: executionId,
      outbox_id: row.id,
    },
    outputs: { ok: true, rail_receipt: receipt, gate_audit_before: row.audit_before_id },
  });

  // 4 — persist the receipt durably (row → dispatched) BEFORE settling, so a
  // crash here leaves a recoverable row (reclaimStale handles both in-flight
  // states) rather than a lost receipt.
  await deps.withPrivileged((c) =>
    deps.outbox.markDispatched(c, row.id, {
      railReceipt: receipt,
      auditAfterId: after.id,
      executionId,
    }),
  );

  // 5 — settle the intent (dispatching → executed). The rail already moved
  // money, so a DB failure here must NOT be treated as "no money moved": route
  // it to retry/reconcile. completeExecution is idempotent, so a reclaimed
  // re-run converges to exactly one settlement.
  try {
    await deps.executor.completeExecution(ctx, {
      paymentIntentId: row.payment_intent_id,
      executionId,
      rail: row.rail,
      railReceipt: receipt,
      idempotencyKey: row.idempotency_key,
    });
  } catch (err) {
    const message = `settle_failed: ${err instanceof Error ? err.message : String(err)}`;
    const attempts = await deps.withPrivileged((c) => deps.outbox.markFailed(c, row.id, message));
    if (attempts >= MAX_DISPATCH_ATTEMPTS) {
      await emitStuck(deps, row, attempts, message);
      await maybeEmitExhausted(deps, row, attempts, message);
      return "reconciling";
    }
    return "retrying";
  }

  await deps.withPrivileged((c) => deps.outbox.markSettled(c, row.id));
  return "settled";
}

/**
 * Terminal path for a PERMANENT dispatch failure (deterministic contract
 * revert — see rails/permanent-failure.ts). The revert guarantees the whole
 * call reverted, so nothing moved: this is the "DEFINITIVE rail rejection"
 * case PaymentIntentService.failExecution exists for. Order matters for crash
 * recovery: the after-audit closes the §6 pair first, then the intent fails
 * (dispatching → failed), and only then does the row leave the claim set — a
 * crash in between leaves the row reclaimable, and the re-run lands in the
 * markReconciling fallback below once the intent is no longer `dispatching`.
 */
async function failPermanently(
  deps: OutboxWorkerDeps,
  row: OutboxRow,
  ctx: ServiceCallContext,
  reason: string,
): Promise<RowOutcome> {
  // Close the §6 audit pair with the failure outcome (same shape as the
  // aborted-handoff after-event in PaymentIntentService.execute).
  const after = await deps.audit.emit({
    tenantId: row.tenant_id,
    layer: "agent",
    actor: deps.workerId,
    action: "payment_intent.execute.after",
    inputs: {
      payment_intent_id: row.payment_intent_id,
      rail: row.rail,
      outbox_id: row.id,
    },
    outputs: {
      ok: false,
      permanent_failure: true,
      error: reason,
      gate_audit_before: row.audit_before_id,
    },
  });

  try {
    await deps.executor.failExecution(ctx, { paymentIntentId: row.payment_intent_id });
  } catch (err) {
    // The intent could not be failed (e.g. it is no longer `dispatching`).
    // Do NOT park the row as failed with the intent state unknown — hand it
    // to ops via the normal reconciling path instead.
    const message = `${reason}; fail_transition_failed: ${
      err instanceof Error ? err.message : String(err)
    }`;
    const attempts = await deps.withPrivileged((c) =>
      deps.outbox.markReconciling(c, row.id, message),
    );
    await emitStuck(deps, row, attempts, message);
    await maybeEmitExhausted(deps, row, attempts, message);
    return "reconciling";
  }

  await deps.withPrivileged((c) =>
    deps.outbox.markPermanentlyFailed(c, row.id, { error: reason, auditAfterId: after.id }),
  );
  await deps.audit.emit({
    tenantId: row.tenant_id,
    layer: "agent",
    actor: deps.workerId,
    action: "execution.outbox.failed",
    inputs: { outbox_id: row.id, payment_intent_id: row.payment_intent_id },
    outputs: { attempt_count: row.attempt_count + 1, last_error: reason, status: "failed" },
  });
  return "failed";
}

async function emitStuck(
  deps: OutboxWorkerDeps,
  row: OutboxRow,
  attempts: number,
  error: string,
): Promise<void> {
  await deps.audit.emit({
    tenantId: row.tenant_id,
    layer: "agent",
    actor: deps.workerId,
    action: "execution.outbox.stuck",
    inputs: { outbox_id: row.id, payment_intent_id: row.payment_intent_id },
    outputs: { attempt_count: attempts, last_error: error, status: "reconciling" },
  });
}

/**
 * Hard-giveup signal, emitted exactly once when a row's attempt count reaches
 * {@link MAX_TOTAL_DISPATCH_ATTEMPTS} (claimNext stops picking the row up at
 * the ceiling, so the count cannot grow past it). Mirrors the webhook DLQ's
 * `audit.webhook.delivery.exhausted` so operators see the giveup, not silence.
 */
async function maybeEmitExhausted(
  deps: OutboxWorkerDeps,
  row: OutboxRow,
  attempts: number,
  error: string,
): Promise<void> {
  if (attempts < MAX_TOTAL_DISPATCH_ATTEMPTS) return;
  await deps.audit.emit({
    tenantId: row.tenant_id,
    layer: "agent",
    actor: deps.workerId,
    action: "execution.outbox.exhausted",
    inputs: { outbox_id: row.id, payment_intent_id: row.payment_intent_id },
    outputs: { attempt_count: attempts, last_error: error, status: "reconciling" },
  });
}

/**
 * Long-running driver: poll `runOutboxCycle` every `intervalMs` until the
 * returned stop() is called. The deployable worker process calls this; the unit
 * tests drive `runOutboxCycle` directly so no timers are involved.
 */
export function startOutboxWorker(
  deps: OutboxWorkerDeps,
  opts: { intervalMs?: number; limit?: number; staleSeconds?: number } = {},
): ManagedWorker {
  const intervalMs = opts.intervalMs ?? 1_000;

  const cycleOpts: { limit?: number; staleSeconds?: number } = {};
  if (opts.limit !== undefined) cycleOpts.limit = opts.limit;
  if (opts.staleSeconds !== undefined) cycleOpts.staleSeconds = opts.staleSeconds;

  return startManagedInterval(
    async () => {
      await runOutboxCycle(deps, cycleOpts);
    },
    intervalMs,
    {
      name: "execution-outbox",
      // Never let one bad cycle kill the loop; surface and continue.
      onError: (err) => console.error("[outbox-worker] cycle failed", err),
    },
  );
}
