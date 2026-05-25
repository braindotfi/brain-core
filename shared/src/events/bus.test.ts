/**
 * H-17 event bus unit tests (no Postgres).
 *
 * Covers publish (INSERT + pg_notify pointer), notification parse/filter, and a
 * subscribe catch-up cycle over a fake ListenClient. The live LISTEN/NOTIFY
 * round-trip, reconnect catch-up, and cross-tenant isolation are a pg
 * integration test, blocked here (see bus.ts SANDBOX NOTE).
 */

import { describe, expect, it, vi } from "vitest";
import type { TenantScopedClient } from "../db/tenant-scoped.js";
import {
  publishDomainEvent,
  parseDomainEventNotification,
  shouldDeliver,
  subscribeDomainEvents,
  type ListenClient,
} from "./bus.js";
import type { DomainEventRow } from "./types.js";

function fakeClient(): {
  client: TenantScopedClient;
  calls: Array<{ sql: string; values: unknown[] }>;
} {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const client = {
    query: vi.fn(async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      return { rows: [], rowCount: 0 };
    }),
  } as unknown as TenantScopedClient;
  return { client, calls };
}

describe("publishDomainEvent", () => {
  it("inserts the row and pg_notify's a pointer, in the caller's tx", async () => {
    const { client, calls } = fakeClient();
    const { id } = await publishDomainEvent(client, "tnt_x", "payment_intent.created", {
      pi: "pi_1",
    });
    expect(id.startsWith("evt_")).toBe(true);

    const insert = calls.find((c) => c.sql.includes("INSERT INTO domain_events"));
    expect(insert?.values).toEqual([
      id,
      "tnt_x",
      "payment_intent.created",
      JSON.stringify({ pi: "pi_1" }),
    ]);

    const notify = calls.find((c) => c.sql.includes("pg_notify"));
    expect(notify?.values?.[0]).toBe("domain_events");
    // Notify carries a POINTER, not the payload.
    const note = JSON.parse(notify?.values?.[1] as string);
    expect(note).toEqual({ id, tenant_id: "tnt_x", event_type: "payment_intent.created" });
  });
});

describe("parseDomainEventNotification", () => {
  it("parses a valid pointer", () => {
    const r = parseDomainEventNotification(
      JSON.stringify({ id: "evt_1", tenant_id: "tnt_x", event_type: "ledger.invoice.created" }),
    );
    expect(r?.event_type).toBe("ledger.invoice.created");
  });
  it("rejects malformed JSON, missing fields, and unknown event types", () => {
    expect(parseDomainEventNotification("not json")).toBeNull();
    expect(parseDomainEventNotification(JSON.stringify({ id: "evt_1" }))).toBeNull();
    expect(
      parseDomainEventNotification(
        JSON.stringify({ id: "evt_1", tenant_id: "tnt_x", event_type: "made.up.event" }),
      ),
    ).toBeNull();
  });
});

describe("shouldDeliver", () => {
  it("delivers all when no filter, else only subscribed types", () => {
    expect(shouldDeliver("payment_intent.created", [])).toBe(true);
    expect(shouldDeliver("payment_intent.created", ["payment_intent.created"])).toBe(true);
    expect(shouldDeliver("audit.root_anchored", ["payment_intent.created"])).toBe(false);
  });
});

describe("subscribeDomainEvents", () => {
  function row(over: Partial<DomainEventRow> = {}): DomainEventRow {
    return {
      id: "evt_1",
      tenant_id: "tnt_x",
      event_type: "payment_intent.created",
      payload: {},
      created_at: new Date(),
      consumed_by: {},
      ...over,
    };
  }

  it("LISTENs, catches up, and delivers matching notifications", async () => {
    let notifyCb: ((m: { channel: string; payload?: string }) => void) | undefined;
    const queries: string[] = [];
    const client: ListenClient = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        return { rows: [] };
      }),
      on: vi.fn((event: string, cb: (m: { channel: string; payload?: string }) => void) => {
        if (event === "notification") notifyCb = cb;
      }),
    };
    const handled: string[] = [];
    await subscribeDomainEvents({
      client,
      subscriberName: "agent-router",
      eventTypes: ["payment_intent.created"],
      handler: async (e) => {
        handled.push(e.id);
      },
      loadEvent: async (id) => (id === "evt_live" ? row({ id: "evt_live" }) : null),
      catchUp: async () => [row({ id: "evt_caught_up" })],
    });

    expect(queries.some((q) => q.includes("LISTEN domain_events"))).toBe(true);
    // catch-up delivered.
    expect(handled).toContain("evt_caught_up");

    // a live notification for a subscribed type is delivered…
    notifyCb?.({
      channel: "domain_events",
      payload: JSON.stringify({
        id: "evt_live",
        tenant_id: "tnt_x",
        event_type: "payment_intent.created",
      }),
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(handled).toContain("evt_live");

    // …but an unsubscribed type is filtered out (no loadEvent call).
    notifyCb?.({
      channel: "domain_events",
      payload: JSON.stringify({
        id: "evt_other",
        tenant_id: "tnt_x",
        event_type: "audit.root_anchored",
      }),
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(handled).not.toContain("evt_other");
  });
});
