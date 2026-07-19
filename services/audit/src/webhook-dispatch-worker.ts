/**
 * Outbound webhook retry worker (recommendations item 13).
 *
 * The inline first dispatch still happens in `WebhookDispatcher.dispatch`
 * (setImmediate fire-and-forget); any attempted failure lands in
 * `webhook_dead_letters` at attempt_count=1 with a 30s cooldown. Successful
 * deliveries record `webhook_delivery_receipts`. This worker drains the DLQ by
 * exponential-backoff schedule (see {@link nextAttemptDelaySeconds}), then runs
 * a durable reconcile scan over committed audit_events to recover first-hop
 * dispatches lost before any attempt was recorded. On transition to
 * MAX_WEBHOOK_DELIVERY_ATTEMPTS it emits both:
 *
 *   - metric `brain.audit.webhook.dlq.count` (tags: tenant_id, endpoint_id,
 *     event_type) — so Grafana shows hard giveups.
 *   - audit event `audit.webhook.delivery.exhausted` — so the audit log
 *     records who/what/when, mirroring how the §6 gate's audit events work.
 *
 * Connection model. The poll query is cross-tenant; the worker process needs
 * BYPASSRLS (the `brain_privileged` role in production) to see other tenants'
 * rows. Per-row retries open a tenant-scoped client via `withTenantScope` and
 * carry the row's `tenant_id`, mirroring the outbox worker (H-04).
 */

import {
  deleteDeadLetterById,
  deliverWebhook,
  FORWARDED_EVENTS,
  getDueDeadLetters,
  getUndeliveredWebhookEvents,
  incrementDeadLetterAttempt,
  MAX_WEBHOOK_DELIVERY_ATTEMPTS,
  recordDeliveryFailure,
  recordDeliverySuccess,
  startManagedInterval,
  leasedCycle,
  withTenantScope,
  type AuditEmitter,
  type ManagedWorker,
  type MetricsEmitter,
} from "@brain/shared";
import type { Pool } from "pg";
import { findWebhookEndpoint } from "./webhooks.js";

/** Same signature as deliverWebhook so tests can inject a stub. */
export type Deliver = typeof deliverWebhook;

export interface WebhookDispatchWorkerDeps {
  pool: Pool;
  audit: AuditEmitter;
  /** Injection seam; defaults to deliverWebhook. */
  deliver?: Deliver;
  /** Optional metrics sink — emits brain.audit.webhook.dlq.count on giveup. */
  metrics?: MetricsEmitter;
  /** Captured on the audit event when this worker exhausts a row. */
  workerId?: string;
  /** Override the cap (defaults to MAX_WEBHOOK_DELIVERY_ATTEMPTS). */
  maxAttempts?: number;
  /** Maximum committed audit events to reconcile per cycle. Defaults to limit. */
  reconcileLimit?: number;
  /** Skip events newer than this so the inline fast path can finish first. */
  reconcileGraceMs?: number;
  /** Only scan this much audit history per cycle to bound anti-join cost. */
  reconcileLookbackMs?: number;
}

export interface CycleResult {
  /** Rows the cycle picked up and processed. */
  attempted: number;
  /** Rows redelivered (or dropped because their endpoint was gone). */
  delivered: number;
  /** Rows whose retry failed but stayed under the cap. */
  failing: number;
  /** Rows whose retry pushed attempt_count to the cap. */
  exhausted: number;
  /** Missed first-hop endpoint/event pairs found by the reconcile scan. */
  reconciled: number;
}

/**
 * Run a single drain cycle. Exported so tests can drive it directly with no
 * timers; the deployable {@link startWebhookDispatchWorker} just polls this.
 */
export async function runWebhookDispatchCycle(
  deps: WebhookDispatchWorkerDeps,
  opts: { limit?: number } = {},
): Promise<CycleResult> {
  const limit = opts.limit ?? 20;
  const max = deps.maxAttempts ?? MAX_WEBHOOK_DELIVERY_ATTEMPTS;
  const deliver = deps.deliver ?? deliverWebhook;
  const workerId = deps.workerId ?? "webhook-dispatch-worker";

  // Cross-tenant scan (BYPASSRLS in prod). Connection released immediately;
  // per-row work re-acquires a tenant-scoped client.
  const c = await deps.pool.connect();
  let due;
  try {
    due = await getDueDeadLetters(c, max, limit);
  } finally {
    c.release();
  }

  const tally: CycleResult = {
    attempted: 0,
    delivered: 0,
    failing: 0,
    exhausted: 0,
    reconciled: 0,
  };
  for (const row of due) {
    tally.attempted += 1;
    const outcome = await withTenantScope(deps.pool, row.tenant_id, async (scoped) => {
      const endpoint = await findWebhookEndpoint(scoped, row.endpoint_id);
      if (endpoint === null) {
        // Endpoint deleted by ops — drop the dead-letter; nothing to retry against.
        await deleteDeadLetterById(scoped, row.id);
        return "delivered" as const;
      }
      const result = await deliver(
        { url: endpoint.url, secret: endpoint.secret },
        JSON.stringify(row.payload),
      );
      if (result.ok) {
        await deleteDeadLetterById(scoped, row.id);
        return "delivered" as const;
      }
      await incrementDeadLetterAttempt(scoped, row.id, result.error ?? "delivery failed");
      const newAttempt = row.attempt_count + 1;
      return newAttempt >= max ? ("exhausted" as const) : ("failing" as const);
    });

    if (outcome === "delivered") {
      tally.delivered += 1;
      continue;
    }
    if (outcome === "failing") {
      tally.failing += 1;
      continue;
    }
    // exhausted — emit metric + audit event so ops sees the hard giveup.
    tally.exhausted += 1;
    deps.metrics?.increment("brain.audit.webhook.dlq.count", {
      tenant_id: row.tenant_id,
      endpoint_id: row.endpoint_id,
      event_type: row.event_type,
    });
    try {
      await deps.audit.emit({
        tenantId: row.tenant_id,
        layer: "audit",
        actor: workerId,
        action: "audit.webhook.delivery.exhausted",
        inputs: {
          endpoint_id: row.endpoint_id,
          event_id: row.event_id,
          event_type: row.event_type,
        },
        outputs: { attempt_count: max, last_error: row.last_error },
      });
    } catch (err) {
      // Re-emit failure must not crash the cycle.
      console.warn("[webhook-worker] failed to emit exhausted audit event", err);
    }
  }

  const reconcileLimit = deps.reconcileLimit ?? limit;
  const reconcileGraceMs = deps.reconcileGraceMs ?? 60_000;
  const reconcileLookbackMs = deps.reconcileLookbackMs ?? 7 * 24 * 60 * 60 * 1000;
  let missed;
  const scan = await deps.pool.connect();
  try {
    missed = await getUndeliveredWebhookEvents(scan, [...FORWARDED_EVENTS], reconcileLimit, {
      graceMs: reconcileGraceMs,
      lookbackMs: reconcileLookbackMs,
    });
  } finally {
    scan.release();
  }

  for (const row of missed) {
    tally.reconciled += 1;
    const payload = {
      id: row.event_id,
      type: row.event_type,
      tenant_id: row.tenant_id,
      created_at: row.created_at.toISOString(),
      data: { inputs: row.inputs, outputs: row.outputs },
    };
    const result = await deliver(
      { url: row.endpoint_url, secret: row.endpoint_secret },
      JSON.stringify(payload),
    );
    await withTenantScope(deps.pool, row.tenant_id, async (scoped) => {
      if (result.ok) {
        await recordDeliverySuccess(scoped, {
          tenantId: row.tenant_id,
          endpointId: row.endpoint_id,
          eventId: row.event_id,
          eventType: row.event_type,
        });
        return;
      }
      await recordDeliveryFailure(scoped, {
        tenantId: row.tenant_id,
        endpointId: row.endpoint_id,
        eventId: row.event_id,
        eventType: row.event_type,
        payload,
        error: result.error ?? "delivery failed",
      });
    });
    if (result.ok) tally.delivered += 1;
    else tally.failing += 1;
  }
  return tally;
}

/**
 * Long-running driver: poll {@link runWebhookDispatchCycle} every
 * `intervalMs` until stop() is called. The deployable worker calls this; unit
 * tests drive `runWebhookDispatchCycle` directly so no timers are involved.
 */
export function startWebhookDispatchWorker(
  deps: WebhookDispatchWorkerDeps,
  opts: { intervalMs?: number; limit?: number } = {},
): ManagedWorker {
  const intervalMs = opts.intervalMs ?? 5_000;
  const cycleOpts: { limit?: number } = {};
  if (opts.limit !== undefined) cycleOpts.limit = opts.limit;

  // Advisory lease: only one replica drains the dead-letter queue at a time
  // (multi-replica safe; no double-delivery across replicas).
  return startManagedInterval(
    leasedCycle({
      pool: deps.pool,
      lockKey: "brain_worker_webhook_dispatch",
      cycle: async () => {
        await runWebhookDispatchCycle(deps, cycleOpts);
      },
      name: "webhook-dispatch",
      metrics: deps.metrics,
    }),
    intervalMs,
    {
      name: "webhook-dispatch",
      onError: (err) => console.error("[webhook-worker] cycle failed", err),
    },
  );
}
