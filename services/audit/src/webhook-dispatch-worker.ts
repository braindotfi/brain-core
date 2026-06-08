/**
 * Outbound webhook retry worker (recommendations item 13).
 *
 * The inline first dispatch still happens in `WebhookDispatcher.dispatch`
 * (setImmediate fire-and-forget); any failure lands in `webhook_dead_letters`
 * at attempt_count=1 with a 30s cooldown. This worker drains the DLQ by
 * exponential-backoff schedule (see {@link nextAttemptDelaySeconds}), retries
 * via the same `deliverWebhook` function the /replay route uses, and on the
 * transition to MAX_WEBHOOK_DELIVERY_ATTEMPTS emits BOTH:
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
  getDueDeadLetters,
  incrementDeadLetterAttempt,
  MAX_WEBHOOK_DELIVERY_ATTEMPTS,
  startManagedInterval,
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

  const tally: CycleResult = { attempted: 0, delivered: 0, failing: 0, exhausted: 0 };
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

  return startManagedInterval(
    async () => {
      await runWebhookDispatchCycle(deps, cycleOpts);
    },
    intervalMs,
    { onError: (err) => console.error("[webhook-worker] cycle failed", err) },
  );
}
