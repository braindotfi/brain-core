/**
 * Outbox worker unit tests.
 *
 * Drives the worker control flow over injected fakes (fake OutboxService, fake
 * RailRegistry, fake executor, in-memory audit). This covers: happy settle,
 * dispatch-failure retry, retry-budget → reconciling + stuck audit, invalid
 * receipt → reconcile (intent NOT failed), settle-failure recovery, and stale
 * claim recovery.
 *
 * SANDBOX NOTE. The properties that need real Postgres semantics are written as
 * an integration test and are BLOCKED here (no Docker/pg):
 *   - crash-injection with a real worker restart settling exactly once,
 *   - concurrent workers claiming the same row via FOR UPDATE SKIP LOCKED,
 *   - the UNIQUE(tenant_id, idempotency_key) enqueue constraint under load,
 *   - RLS on execution_outbox under the brain_app role.
 * These run against pg in services/execution test:integration once the
 * Docker/Postgres environment is available (see the H-04 summary).
 */

import { describe, expect, it, vi } from "vitest";
import { InMemoryAuditEmitter, brainError, newPaymentIntentId, newTenantId } from "@brain/shared";
import type { Rail, RailDispatchResult } from "../rails/types.js";
import type { RailRegistry } from "../rails/stubs.js";
import {
  MAX_TOTAL_DISPATCH_ATTEMPTS,
  type OutboxRow,
  type OutboxService,
} from "./OutboxService.js";
import { processClaimedRow, runOutboxCycle, type OutboxExecutor } from "./worker.js";

/** The shape OnchainBaseRail throws for a deterministic contract revert. */
function permanentRevertError(): Error {
  return brainError("execution_rail_declined", "on-chain execute reverted: 0x49aeece1", {
    details: { permanent_failure: true, decoded_revert: "ExceedsPerTxCap()" },
  });
}

const TENANT = newTenantId();
const PI = newPaymentIntentId();

function makeRow(over: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: "exo_1",
    tenant_id: TENANT,
    payment_intent_id: PI,
    execution_id: null,
    rail: "bank_ach",
    idempotency_key: `pi:${PI}:pd_x`,
    payload: {
      kind: "ach_outbound",
      source_account_id: "acct_1",
      destination_counterparty_id: "cp_1",
      amount: "100.00",
      currency: "USD",
    },
    payload_hash: Buffer.from("hash"),
    status: "dispatching",
    attempt_count: 0,
    last_error: null,
    last_attempt_at: null,
    rail_receipt: null,
    audit_before_id: "evt_before",
    audit_after_id: null,
    reservation_id: null,
    locked_at: new Date(),
    locked_by: "worker_test",
    created_at: new Date(),
    dispatched_at: null,
    completed_at: null,
    ...over,
  };
}

/** A rail whose dispatch is controlled by the test. */
function railWith(dispatch: () => Promise<RailDispatchResult>): RailRegistry {
  const rail: Rail = { kind: "bank_ach", dispatch: vi.fn(dispatch) };
  return { get: vi.fn(() => rail) } as unknown as RailRegistry;
}

const validAchReceipt = async (): Promise<RailDispatchResult> => ({
  receipt: { rail: "ach", ach_trace: "stub-trace-1", stub: true },
});

interface FakeOutbox {
  reclaimStale: ReturnType<typeof vi.fn>;
  claimNext: ReturnType<typeof vi.fn>;
  markDispatched: ReturnType<typeof vi.fn>;
  markSettled: ReturnType<typeof vi.fn>;
  markFailed: ReturnType<typeof vi.fn>;
  markReconciling: ReturnType<typeof vi.fn>;
  markPermanentlyFailed: ReturnType<typeof vi.fn>;
}

function makeDeps(opts: {
  rows?: OutboxRow[];
  dispatch?: () => Promise<RailDispatchResult>;
  markFailedReturns?: number;
  markReconcilingReturns?: number;
  completeThrows?: boolean;
  failExecutionThrows?: boolean;
  beforeDispatch?: Parameters<typeof processClaimedRow>[0]["beforeDispatch"];
}): {
  deps: Parameters<typeof runOutboxCycle>[0];
  outbox: FakeOutbox;
  executor: {
    completeExecution: ReturnType<typeof vi.fn>;
    failExecution: ReturnType<typeof vi.fn>;
  };
  audit: InMemoryAuditEmitter;
} {
  const outbox: FakeOutbox = {
    reclaimStale: vi.fn(async () => []),
    claimNext: vi.fn(async () => opts.rows ?? []),
    markDispatched: vi.fn(async () => undefined),
    markSettled: vi.fn(async () => undefined),
    markFailed: vi.fn(async () => opts.markFailedReturns ?? 1),
    markReconciling: vi.fn(async () => opts.markReconcilingReturns ?? 1),
    markPermanentlyFailed: vi.fn(async () => undefined),
  };
  const executor: OutboxExecutor & {
    completeExecution: ReturnType<typeof vi.fn>;
    failExecution: ReturnType<typeof vi.fn>;
  } = {
    completeExecution: vi.fn(async () => {
      if (opts.completeThrows === true) throw new Error("db down");
    }),
    failExecution: vi.fn(async () => {
      if (opts.failExecutionThrows === true) throw new Error("intent no longer dispatching");
    }),
  };
  const audit = new InMemoryAuditEmitter();
  const deps = {
    outbox: outbox as unknown as OutboxService,
    rails: railWith(opts.dispatch ?? validAchReceipt),
    executor,
    audit,
    withPrivileged: <T>(
      fn: (c: { query: () => Promise<{ rows: never[]; rowCount: number }> }) => Promise<T>,
    ) => fn({ query: async () => ({ rows: [], rowCount: 0 }) }),
    ...(opts.beforeDispatch !== undefined ? { beforeDispatch: opts.beforeDispatch } : {}),
    workerId: "worker_test",
  };
  return { deps, outbox, executor, audit };
}

describe("processClaimedRow", () => {
  it("settles a clean dispatch: receipt valid → audit-after + completeExecution + markSettled", async () => {
    const { deps, outbox, executor, audit } = makeDeps({});
    const outcome = await processClaimedRow(deps, makeRow({ reservation_id: "rsv_1" }));

    expect(outcome).toBe("settled");
    expect(executor.completeExecution).toHaveBeenCalledTimes(1);
    expect(executor.completeExecution.mock.calls[0]?.[1]).toMatchObject({
      paymentIntentId: PI,
      reservationId: "rsv_1",
    });
    expect(outbox.markDispatched).toHaveBeenCalledTimes(1);
    expect(outbox.markSettled).toHaveBeenCalledTimes(1);

    const after = audit.events.find((e) => e.action === "payment_intent.execute.after");
    expect(after?.outputs.ok).toBe(true);
    // Audit pair is linked across the async boundary via the before-event id.
    expect(after?.outputs.gate_audit_before).toBe("evt_before");
  });

  it("retries when dispatch throws and the budget is not exhausted", async () => {
    const { deps, outbox, executor, audit } = makeDeps({
      dispatch: async () => {
        throw new Error("rail timeout");
      },
      markFailedReturns: 1,
    });
    const outcome = await processClaimedRow(deps, makeRow());

    expect(outcome).toBe("retrying");
    expect(outbox.markFailed).toHaveBeenCalledTimes(1);
    expect(executor.completeExecution).not.toHaveBeenCalled();
    expect(audit.events.find((e) => e.action === "execution.outbox.stuck")).toBeUndefined();
  });

  it("escalates to reconciling + stuck audit after the retry budget is spent", async () => {
    const { deps, executor, audit } = makeDeps({
      dispatch: async () => {
        throw new Error("rail down");
      },
      markFailedReturns: 3, // == MAX_DISPATCH_ATTEMPTS
    });
    const outcome = await processClaimedRow(deps, makeRow());

    expect(outcome).toBe("reconciling");
    expect(executor.completeExecution).not.toHaveBeenCalled();
    const stuck = audit.events.find((e) => e.action === "execution.outbox.stuck");
    expect(stuck).toBeDefined();
    expect(stuck?.outputs.attempt_count).toBe(3);
  });

  it("reconciles (does NOT fail the intent) when a dispatched receipt is malformed", async () => {
    const { deps, outbox, executor, audit } = makeDeps({
      // ACH receipt missing required ach_trace → invalid.
      dispatch: async () => ({ receipt: { rail: "ach", stub: true } }),
    });
    const outcome = await processClaimedRow(deps, makeRow());

    expect(outcome).toBe("reconciling");
    expect(outbox.markReconciling).toHaveBeenCalledTimes(1);
    // Money may have moved — the intent must NOT be auto-failed.
    expect(executor.failExecution).not.toHaveBeenCalled();
    expect(executor.completeExecution).not.toHaveBeenCalled();
    expect(audit.events.find((e) => e.action === "execution.outbox.stuck")).toBeDefined();
  });

  it("routes a settle (DB) failure to retry rather than wrongly marking failed", async () => {
    const { deps, outbox, executor } = makeDeps({ completeThrows: true, markFailedReturns: 1 });
    const outcome = await processClaimedRow(deps, makeRow());

    expect(outcome).toBe("retrying");
    expect(executor.completeExecution).toHaveBeenCalledTimes(1);
    // Receipt was persisted before the settle attempt (recoverable on reclaim).
    expect(outbox.markDispatched).toHaveBeenCalledTimes(1);
    expect(outbox.markFailed).toHaveBeenCalledTimes(1);
    expect(outbox.markSettled).not.toHaveBeenCalled();
  });

  it("terminally fails a PERMANENT dispatch failure: failExecution + status=failed, no retry", async () => {
    // The incident shape: ExceedsPerTxCap reverts deterministically; retrying
    // can never succeed, so the worker must not burn the retry budget.
    const { deps, outbox, executor, audit } = makeDeps({
      dispatch: async () => {
        throw permanentRevertError();
      },
    });
    const outcome = await processClaimedRow(deps, makeRow({ reservation_id: "rsv_1" }));

    expect(outcome).toBe("failed");
    // Definitive rejection (nothing moved) → the intent is failed, not retried.
    expect(executor.failExecution).toHaveBeenCalledTimes(1);
    expect(executor.failExecution.mock.calls[0]?.[1]).toEqual({
      paymentIntentId: PI,
      reservationId: "rsv_1",
    });
    expect(executor.completeExecution).not.toHaveBeenCalled();
    expect(outbox.markPermanentlyFailed).toHaveBeenCalledTimes(1);
    expect(outbox.markFailed).not.toHaveBeenCalled();
    expect(outbox.markReconciling).not.toHaveBeenCalled();
    // The decoded reason lands on the terminal row write.
    const [, failedId, failedArgs] = outbox.markPermanentlyFailed.mock.calls[0] as [
      unknown,
      string,
      { error: string; auditAfterId: string },
    ];
    expect(failedId).toBe("exo_1");
    expect(failedArgs.error).toContain("ExceedsPerTxCap()");

    // §6 pair closes with the failure outcome, linked to the gate's before-event.
    const after = audit.events.find((e) => e.action === "payment_intent.execute.after");
    expect(after?.outputs.ok).toBe(false);
    expect(after?.outputs.permanent_failure).toBe(true);
    expect(after?.outputs.gate_audit_before).toBe("evt_before");
    expect(String(after?.outputs.error)).toContain("ExceedsPerTxCap()");
    // Ops signal mirrors execution.outbox.stuck.
    const failed = audit.events.find((e) => e.action === "execution.outbox.failed");
    expect(failed).toBeDefined();
    expect(failed?.outputs.status).toBe("failed");
  });

  it("routes a permanent failure to reconciling when the intent can no longer be failed", async () => {
    // failExecution throws (e.g. crash-recovery re-run: the intent already left
    // `dispatching`). The row must NOT park as failed with the intent state
    // unknown — it goes to ops via reconciling.
    const { deps, outbox, executor, audit } = makeDeps({
      dispatch: async () => {
        throw permanentRevertError();
      },
      failExecutionThrows: true,
    });
    const outcome = await processClaimedRow(deps, makeRow());

    expect(outcome).toBe("reconciling");
    expect(executor.failExecution).toHaveBeenCalledTimes(1);
    expect(outbox.markPermanentlyFailed).not.toHaveBeenCalled();
    expect(outbox.markReconciling).toHaveBeenCalledTimes(1);
    const stuck = audit.events.find((e) => e.action === "execution.outbox.stuck");
    expect(String(stuck?.outputs.last_error)).toContain("fail_transition_failed");
  });

  it("emits execution.outbox.exhausted exactly at the total-attempt ceiling", async () => {
    const { deps, audit } = makeDeps({
      dispatch: async () => {
        throw new Error("rpc flake");
      },
      markFailedReturns: MAX_TOTAL_DISPATCH_ATTEMPTS,
    });
    const outcome = await processClaimedRow(deps, makeRow());

    expect(outcome).toBe("reconciling");
    const exhausted = audit.events.find((e) => e.action === "execution.outbox.exhausted");
    expect(exhausted).toBeDefined();
    expect(exhausted?.outputs.attempt_count).toBe(MAX_TOTAL_DISPATCH_ATTEMPTS);
    // The stuck escalation still fires alongside the giveup.
    expect(audit.events.find((e) => e.action === "execution.outbox.stuck")).toBeDefined();
  });

  it("does NOT emit exhausted below the ceiling", async () => {
    const { deps, audit } = makeDeps({
      dispatch: async () => {
        throw new Error("rpc flake");
      },
      markFailedReturns: 3, // == MAX_DISPATCH_ATTEMPTS, < MAX_TOTAL_DISPATCH_ATTEMPTS
    });
    await processClaimedRow(deps, makeRow());
    expect(audit.events.find((e) => e.action === "execution.outbox.exhausted")).toBeUndefined();
  });

  it("§6 runtime invariant: refuses to dispatch a row with no audit_before_id", async () => {
    // Belt to the gate-bypass lint suspender: if a code path ever races around
    // scripts/check-gate-bypass.mjs and writes an outbox row before audit-before
    // fires, the worker must NOT move money. It reconciles + emits a stuck event.
    const { deps, outbox, executor, audit } = makeDeps({});
    const outcome = await processClaimedRow(deps, makeRow({ audit_before_id: "" }));

    expect(outcome).toBe("reconciling");
    // Did not dispatch the rail.
    expect(executor.completeExecution).not.toHaveBeenCalled();
    expect(outbox.markReconciling).toHaveBeenCalledTimes(1);
    const stuck = audit.events.find((e) => e.action === "execution.outbox.stuck");
    expect(stuck).toBeDefined();
    expect(String(stuck?.outputs.last_error)).toContain("audit_before_id");
  });

  it("refuses to dispatch when the pre-dispatch guard blocks the creator agent", async () => {
    const beforeDispatch = vi.fn(async () => ({
      ok: false as const,
      reason: "agent_state=quarantined",
    }));
    const { deps, outbox, executor, audit } = makeDeps({
      beforeDispatch,
      dispatch: validAchReceipt,
    });
    const row = makeRow();
    const outcome = await processClaimedRow(deps, row);

    expect(outcome).toBe("reconciling");
    expect(beforeDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, actor: "worker_test" }),
      row,
    );
    expect(outbox.markReconciling).toHaveBeenCalledTimes(1);
    expect(executor.completeExecution).not.toHaveBeenCalled();
    expect(deps.rails.get("bank_ach").dispatch).not.toHaveBeenCalled();
    const stuck = audit.events.find((e) => e.action === "execution.outbox.stuck");
    expect(String(stuck?.outputs.last_error)).toContain("agent_state=quarantined");
  });
});

describe("runOutboxCycle", () => {
  it("reclaims stale rows and processes the claimed batch, tallying outcomes", async () => {
    const { deps, outbox } = makeDeps({
      rows: [makeRow({ id: "exo_a" }), makeRow({ id: "exo_b" })],
    });
    outbox.reclaimStale.mockResolvedValueOnce([makeRow({ id: "exo_stale" })]);

    const result = await runOutboxCycle(deps, { limit: 5, staleSeconds: 120 });

    expect(outbox.reclaimStale).toHaveBeenCalledTimes(1);
    expect(outbox.claimNext).toHaveBeenCalledTimes(1);
    expect(result.reclaimed).toBe(1);
    expect(result.claimed).toBe(2);
    expect(result.settled).toBe(2);
  });

  it("does nothing when the queue is empty", async () => {
    const { deps, outbox } = makeDeps({ rows: [] });
    const result = await runOutboxCycle(deps);
    expect(result.claimed).toBe(0);
    expect(result.settled).toBe(0);
    expect(outbox.markSettled).not.toHaveBeenCalled();
  });

  it("tallies permanently failed rows under `failed`", async () => {
    const { deps } = makeDeps({
      rows: [makeRow({ id: "exo_perm" })],
      dispatch: async () => {
        throw permanentRevertError();
      },
    });
    const result = await runOutboxCycle(deps);
    expect(result.failed).toBe(1);
    expect(result.settled).toBe(0);
    expect(result.reconciling).toBe(0);
  });
});
