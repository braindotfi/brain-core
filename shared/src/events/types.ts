/**
 * H-17 canonical domain-event vocabulary for the runtime event bus.
 *
 * Distinct from `triggers.ts` (the agent-routing trigger names consumed off the
 * BullMQ queue): these are SYSTEM LIFECYCLE events published to the Postgres
 * LISTEN/NOTIFY `domain_events` substrate (see bus.ts) for durable runtime
 * fan-out. Durability of the record of truth still comes from the audit log;
 * this bus decouples producers from consumers at runtime.
 */

export const DOMAIN_EVENT_TYPES = [
  "raw.artifact.ingested",
  "raw.artifact.tombstoned",
  "ledger.transaction.created",
  "ledger.invoice.created",
  "ledger.obligation.due_soon",
  "ledger.counterparty.risk_changed",
  "ledger.reconciliation.matched",
  "policy.decision.created",
  "agent.route.selected",
  "agent.run.started",
  "agent.run.completed",
  "payment_intent.created",
  "payment_intent.gate_failed",
  "payment_intent.executed",
  "payment_intent.shadow_completed",
  "execution.rail_dispatched",
  "execution.outbox.stuck",
  "audit.root_anchored",
  "audit.anchor.orphan_detected",
] as const;

export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];

export function isDomainEventType(s: string): s is DomainEventType {
  return (DOMAIN_EVENT_TYPES as readonly string[]).includes(s);
}

/** The Postgres NOTIFY channel the bus publishes/listens on. */
export const DOMAIN_EVENTS_CHANNEL = "domain_events";

/** A persisted domain event row. */
export interface DomainEventRow {
  id: string;
  tenant_id: string;
  event_type: DomainEventType;
  payload: Record<string, unknown>;
  created_at: Date;
  consumed_by: Record<string, unknown>;
}

/** The small pointer payload carried over pg_notify (NOT the full event). */
export interface DomainEventNotification {
  id: string;
  tenant_id: string;
  event_type: DomainEventType;
}
