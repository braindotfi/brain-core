/**
 * Domain-event vocabulary for agent routing.
 *
 * These are the trigger names agents declare in their definitions. Producers
 * (Ledger, Execution) emit them via `emitDomainEvent`; the agent-router worker
 * consumes them off the `agentRoute` BullMQ queue, routes, and proposes.
 *
 * Phase 1 ships the vocabulary + the emit/enqueue seam. Producers wire real
 * detection points to `emitDomainEvent` (see the integration markers in
 * services/ledger and services/execution).
 */

import { createQueue, type QueueFactoryOptions } from "../queue/factory.js";
import { QUEUE_NAMES, type BrainJobEnvelope } from "../queue/types.js";

export const DOMAIN_EVENTS = [
  // Phase 1 triggers (collections, treasury, reconciliation).
  "invoice.overdue",
  "payment.failed",
  "receivable.aging_threshold_crossed",
  "cash.balance_high",
  "cash.balance_low",
  "runway.changed",
  "yield_opportunity.detected",
  "transaction.unreconciled",
  "statement.imported",
  "reconciliation.candidate_found",
  // Phase 2 triggers (business agent library).
  "bill.due_soon", // payment
  "invoice.approved", // payment
  "proposal.awaiting_second_approval", // payment approval
  "payment.scheduled", // payment
  "recurring_charge.detected", // subscription
  "vendor.duplicate_detected", // subscription
  "subscription.price_changed", // subscription
  "vendor.created", // vendor_risk
  "vendor.bank_details_changed", // vendor_risk
  "payment.destination_changed", // vendor_risk
  "forecast.requested", // cash_forecast
  "cashflow.material_change", // cash_forecast
  "large_payable.created", // cash_forecast
  "dispute.created", // dispute
  "chargeback.received", // dispute
  "payment.mismatch", // dispute
  "policy.violation", // compliance
  "approval.missing", // compliance
  "audit.gap_detected", // compliance
  "revenue.changed", // revenue_intel
  "customer.payment_behavior_changed", // revenue_intel
  "contract.renewal_upcoming", // revenue_intel
  "transaction.unusual", // fraud_anomaly
  "merchant.risk_detected", // fraud_anomaly
  "duplicate_charge.detected", // fraud_anomaly
] as const;

export type DomainEvent = (typeof DOMAIN_EVENTS)[number];

export function isDomainEvent(s: string): s is DomainEvent {
  return (DOMAIN_EVENTS as readonly string[]).includes(s);
}

export interface RoutingJobPayload {
  readonly event: DomainEvent;
  readonly context?: Record<string, unknown>;
}

/** Enqueue a routing job. Implemented over a BullMQ queue at boot. */
export type RoutingEnqueue = (envelope: BrainJobEnvelope<RoutingJobPayload>) => Promise<void>;

export interface EmitDomainEventInput {
  readonly tenantId: string;
  readonly event: DomainEvent;
  readonly context?: Record<string, unknown>;
  readonly requestId?: string;
}

/** Emit a domain event for agent routing. */
export async function emitDomainEvent(
  enqueue: RoutingEnqueue,
  input: EmitDomainEventInput,
): Promise<void> {
  try {
    await enqueue({
      tenantId: input.tenantId,
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      payload: {
        event: input.event,
        ...(input.context !== undefined ? { context: input.context } : {}),
      },
    });
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: "warn",
        message: "domain_event_enqueue_failed",
        tenant_id: input.tenantId,
        request_id: input.requestId ?? null,
        event: input.event,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/** Build a RoutingEnqueue backed by the `agentRoute` BullMQ queue. */
export function createRoutingEnqueue(opts: QueueFactoryOptions): RoutingEnqueue {
  const queue = createQueue<RoutingJobPayload>(QUEUE_NAMES.agentRoute, opts);
  return async (envelope) => {
    await queue.add("route", envelope);
  };
}
