/**
 * H-17 domain event bus over Postgres LISTEN/NOTIFY.
 *
 * publish(): inserts a `domain_events` row AND pg_notify's a small pointer, both
 * inside the CALLER'S transaction (takes a tenant-scoped client) — so an event
 * is published iff the producing write commits. Subscribers receive the pointer,
 * then load/handle the row; on reconnect they catch up from a cursor.
 *
 * SANDBOX NOTE: publish + the pure notification parse/filter helpers are
 * unit-tested with a fake client. The LISTEN/NOTIFY round-trip (notified within
 * 100ms), reconnect catch-up, and cross-tenant isolation require Postgres and
 * are an integration test, blocked here (no pg — see the H-17 summary).
 */

import { newAuditEventId } from "../ids.js";
import type { TenantScopedClient } from "../db/tenant-scoped.js";
import {
  DOMAIN_EVENTS_CHANNEL,
  isDomainEventType,
  type DomainEventNotification,
  type DomainEventRow,
  type DomainEventType,
} from "./types.js";

/** Publish a domain event inside the caller's tenant-scoped transaction. */
export async function publishDomainEvent(
  client: TenantScopedClient,
  tenantId: string,
  eventType: DomainEventType,
  payload: Record<string, unknown>,
): Promise<{ id: string }> {
  const id = newAuditEventId(); // evt_<ulid>
  await client.query(
    `INSERT INTO domain_events (id, tenant_id, event_type, payload) VALUES ($1, $2, $3, $4)`,
    [id, tenantId, eventType, JSON.stringify(payload)],
  );
  // Notify a POINTER, not the payload (pg_notify caps at ~8000 bytes); the
  // subscriber loads the full row. The notify rides the same transaction, so it
  // fires only on commit.
  const note: DomainEventNotification = { id, tenant_id: tenantId, event_type: eventType };
  await client.query(`SELECT pg_notify($1, $2)`, [DOMAIN_EVENTS_CHANNEL, JSON.stringify(note)]);
  return { id };
}

/** Parse a pg_notify payload string into a typed notification, or null. */
export function parseDomainEventNotification(raw: string): DomainEventNotification | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (v === null || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (
    typeof o.id !== "string" ||
    typeof o.tenant_id !== "string" ||
    typeof o.event_type !== "string" ||
    !isDomainEventType(o.event_type)
  ) {
    return null;
  }
  return { id: o.id, tenant_id: o.tenant_id, event_type: o.event_type };
}

/** True iff a subscriber for `subscribed` should be delivered `eventType`. */
export function shouldDeliver(
  eventType: DomainEventType,
  subscribed: ReadonlyArray<DomainEventType>,
): boolean {
  return subscribed.length === 0 || subscribed.includes(eventType);
}

/** Minimal long-lived client the subscriber needs (a dedicated pg Client). */
export interface ListenClient {
  query(text: string, values?: ReadonlyArray<unknown>): Promise<{ rows: unknown[] }>;
  on(event: "notification", cb: (msg: { channel: string; payload?: string }) => void): void;
  on(event: "error", cb: (err: unknown) => void): void;
}

export interface SubscribeDeps {
  /** A dedicated long-lived client (NOT pooled) for LISTEN. */
  client: ListenClient;
  /** Stable subscriber name (recorded in the consumed_by cursor). */
  subscriberName: string;
  /** Event types to receive; [] = all. */
  eventTypes: ReadonlyArray<DomainEventType>;
  /** Handle one event. The subscriber loads the full row for the notification. */
  handler: (event: DomainEventRow) => Promise<void>;
  /** Load full rows for a notification (tenant-scoped on the caller's side). */
  loadEvent: (id: string) => Promise<DomainEventRow | null>;
  /** Catch-up: rows not yet consumed by this subscriber (on (re)connect). */
  catchUp?: () => Promise<DomainEventRow[]>;
}

/**
 * Subscribe to the bus: LISTEN on the channel, catch up from the cursor, then
 * deliver matching events to the handler. Returns a stop() that removes the
 * listener. Requires a real long-lived pg Client (blocked in the sandbox).
 */
export async function subscribeDomainEvents(deps: SubscribeDeps): Promise<{ stop: () => void }> {
  await deps.client.query(`LISTEN ${DOMAIN_EVENTS_CHANNEL}`, []);

  // Catch-up first so events that fired while disconnected are not lost.
  if (deps.catchUp !== undefined) {
    for (const row of await deps.catchUp()) {
      if (shouldDeliver(row.event_type, deps.eventTypes)) await deps.handler(row);
    }
  }

  let stopped = false;
  const onNotification = (msg: { channel: string; payload?: string }): void => {
    if (stopped || msg.channel !== DOMAIN_EVENTS_CHANNEL || msg.payload === undefined) return;
    const note = parseDomainEventNotification(msg.payload);
    if (note === null || !shouldDeliver(note.event_type, deps.eventTypes)) return;
    void (async () => {
      const row = await deps.loadEvent(note.id);
      if (row !== null) await deps.handler(row);
    })();
  };
  deps.client.on("notification", onNotification);

  return {
    stop: () => {
      stopped = true;
    },
  };
}
