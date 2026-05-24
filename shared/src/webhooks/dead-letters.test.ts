import { describe, expect, it, vi } from "vitest";
import type { TenantScopedClient } from "../db/tenant-scoped.js";
import {
  MAX_WEBHOOK_DELIVERY_ATTEMPTS,
  clearDeadLetter,
  getReplayableDeadLetters,
  incrementDeadLetterAttempt,
  listDeadLetters,
  recordDeliveryFailure,
} from "./dead-letters.js";

function fakeClient(handler: (sql: string, values: unknown[]) => unknown[]): {
  client: TenantScopedClient;
  calls: Array<{ sql: string; values: unknown[] }>;
} {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const client = {
    query: vi.fn(async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      const rows = handler(sql, values);
      return { rows, rowCount: rows.length };
    }),
  } as unknown as TenantScopedClient;
  return { client, calls };
}

describe("webhook dead-letters repo", () => {
  it("recordDeliveryFailure upserts (ON CONFLICT increments attempt_count)", async () => {
    const { client, calls } = fakeClient(() => []);
    await recordDeliveryFailure(client, {
      tenantId: "tnt_x",
      endpointId: "whe_1",
      eventId: "evt_1",
      eventType: "payment_intent.created",
      payload: { id: "evt_1" },
      error: "HTTP 500",
    });
    const q = calls[0];
    expect(q?.sql).toContain("INSERT INTO webhook_dead_letters");
    expect(q?.sql).toContain("ON CONFLICT (tenant_id, endpoint_id, event_id) DO UPDATE");
    expect(q?.sql).toContain("attempt_count = webhook_dead_letters.attempt_count + 1");
    // payload stored as JSON, error captured.
    expect(q?.values[5]).toBe(JSON.stringify({ id: "evt_1" }));
    expect(q?.values[6]).toBe("HTTP 500");
  });

  it("clearDeadLetter deletes by (endpoint, event)", async () => {
    const { client, calls } = fakeClient(() => []);
    await clearDeadLetter(client, "whe_1", "evt_1");
    expect(calls[0]?.sql).toContain("DELETE FROM webhook_dead_letters");
    expect(calls[0]?.values).toEqual(["whe_1", "evt_1"]);
  });

  it("getReplayableDeadLetters only returns rows under the attempt cap", async () => {
    const { client, calls } = fakeClient(() => [{ id: "wdl_1", attempt_count: 2 }]);
    const rows = await getReplayableDeadLetters(client, "whe_1");
    expect(rows).toHaveLength(1);
    expect(calls[0]?.sql).toContain("attempt_count < $2");
    expect(calls[0]?.values).toEqual(["whe_1", MAX_WEBHOOK_DELIVERY_ATTEMPTS]);
  });

  it("incrementDeadLetterAttempt bumps the counter + records the error", async () => {
    const { client, calls } = fakeClient(() => []);
    await incrementDeadLetterAttempt(client, "wdl_1", "still down");
    expect(calls[0]?.sql).toContain("attempt_count = attempt_count + 1");
    expect(calls[0]?.values).toEqual(["wdl_1", "still down"]);
  });

  it("listDeadLetters returns rows for an endpoint", async () => {
    const { client } = fakeClient(() => [{ id: "wdl_1", event_id: "evt_1" }]);
    const rows = await listDeadLetters(client, "whe_1");
    expect(rows[0]?.event_id).toBe("evt_1");
  });
});
