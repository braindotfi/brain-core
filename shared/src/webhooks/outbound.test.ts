import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { AuditEvent } from "../audit/types.js";
import { buildWebhookPayload, FORWARDED_EVENTS, WebhookDispatcher } from "./outbound.js";

describe("FORWARDED_EVENTS", () => {
  it("includes customer-facing proposal, agent, raw, and terminal payment events", () => {
    expect(FORWARDED_EVENTS.has("proposal.decided")).toBe(true);
    expect(FORWARDED_EVENTS.has("agent.action.proposed")).toBe(true);
    expect(FORWARDED_EVENTS.has("raw.ingest.new")).toBe(true);
    expect(FORWARDED_EVENTS.has("raw.ingest.deduplicated")).toBe(true);
    expect(FORWARDED_EVENTS.has("raw.extraction.status_changed")).toBe(true);
    expect(FORWARDED_EVENTS.has("raw.source.status_changed")).toBe(true);
    expect(FORWARDED_EVENTS.has("payment_intent.executed")).toBe(true);
    expect(FORWARDED_EVENTS.has("payment_intent.failed")).toBe(true);
    expect(FORWARDED_EVENTS.has("payment_intent.reconciling")).toBe(true);
  });

  it("does not advertise the stale raw.ingest.completed action", () => {
    expect(FORWARDED_EVENTS.has("raw.ingest.completed")).toBe(false);
  });
});

const TENANT = "tnt_01J0000000000000000000000A";

/**
 * Models real Postgres `SET LOCAL` (`is_local=true`) semantics precisely
 * enough to catch F6: the value only survives to the NEXT statement when
 * `set_config` ran inside an explicit transaction the caller controls
 * (BEGIN..COMMIT). Outside one, the implicit per-statement transaction ends
 * immediately, so the scope is already gone by the following query -- which
 * is exactly the bug the bare `client.query("SELECT set_config(...)")` fast
 * path had, with no BEGIN around it.
 */
function makeRlsFakePool(endpointRow: Record<string, unknown>) {
  let inTransaction = false;
  let scopedTenantId: string | null = null;
  const calls: string[] = [];
  const client = {
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      calls.push(sql);
      if (sql === "BEGIN") {
        inTransaction = true;
        return { rows: [], rowCount: 0 };
      }
      if (sql === "COMMIT" || sql === "ROLLBACK") {
        inTransaction = false;
        scopedTenantId = null;
        return { rows: [], rowCount: 0 };
      }
      if (sql.startsWith("SELECT set_config")) {
        const [tenantId] = values as [string];
        scopedTenantId = inTransaction ? String(tenantId) : null;
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("FROM webhook_endpoints")) {
        const [tenantId] = (values ?? []) as [string];
        if (scopedTenantId !== tenantId) return { rows: [], rowCount: 0 };
        return { rows: [endpointRow], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  return {
    pool: { connect: vi.fn(async () => client) } as unknown as Pool,
    calls,
  };
}

function testEvent(action: string): AuditEvent {
  return {
    id: "evt_1",
    tenantId: TENANT,
    layer: "execution",
    actor: "user_1",
    action,
    inputs: {},
    outputs: {},
    eventHash: "a".repeat(64),
    prevEventHash: null,
    createdAt: "2026-07-20T00:00:00.000Z",
  };
}

describe("WebhookDispatcher — F6 fast path finds registered endpoints", () => {
  it("scopes the endpoint query to the event's tenant inside one real transaction", async () => {
    const { pool, calls } = makeRlsFakePool({
      id: "webh_1",
      // A blocked (SSRF-guard) literal IP: deliverWebhook resolves without
      // any real network call, so this test stays offline.
      url: "http://169.254.169.254/hook",
      secret: "s",
      enabled_events: null,
    });
    const dispatcher = new WebhookDispatcher(pool);

    await dispatcher.dispatch(testEvent("proposal.decided"));

    // The endpoint row was only visible because BEGIN ran before
    // set_config, matching real SET LOCAL semantics -- proof the fast path
    // actually finds a registered endpoint instead of silently seeing zero
    // rows. The dead-letter write for the (blocked-URL) delivery failure is
    // the observable evidence that `targets` was non-empty.
    expect(calls).toContain("BEGIN");
    expect(calls.some((sql) => sql.includes("INSERT INTO webhook_dead_letters"))).toBe(true);
  });

  it("skips endpoint lookups entirely for non-forwarded event types", async () => {
    const { pool, calls } = makeRlsFakePool({
      id: "webh_1",
      url: "http://169.254.169.254/hook",
      secret: "s",
      enabled_events: null,
    });
    const dispatcher = new WebhookDispatcher(pool);

    await dispatcher.dispatch(testEvent("some.unforwarded.event"));

    expect(calls).toHaveLength(0);
  });
});

describe("buildWebhookPayload", () => {
  it("carries the audit correlation id into the outbound payload", () => {
    const payload = buildWebhookPayload({
      id: "evt_1",
      tenantId: "tnt_1",
      layer: "execution",
      actor: "user_1",
      action: "proposal.decided",
      inputs: { proposal_id: "prop_1" },
      outputs: { status: "acknowledged" },
      correlationId: "req_client_1",
      eventHash: "a".repeat(64),
      prevEventHash: null,
      createdAt: "2026-07-20T00:00:00.000Z",
    });
    expect(payload).toMatchObject({
      id: "evt_1",
      type: "proposal.decided",
      correlation_id: "req_client_1",
    });
  });
});
