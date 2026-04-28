import { describe, expect, it, vi } from "vitest";
import {
  SUPPORTED_AUDIT_ENTITY_TYPES,
  findEventsByEntity,
} from "./repository.js";

/**
 * Repository unit tests for the v0.3 entity-history endpoint helper.
 * Covers the type-map gate, predicate construction (hits BOTH inputs and
 * outputs), and the payment_intent special case (also matches by
 * policy_decision_id).
 */

function fakeClient(): {
  client: { query: ReturnType<typeof vi.fn> };
  log: { sql: string; values: unknown[] }[];
} {
  const log: { sql: string; values: unknown[] }[] = [];
  const client = {
    query: vi.fn(async (sql: string, values?: ReadonlyArray<unknown>) => {
      log.push({ sql, values: Array.from(values ?? []) });
      return { rows: [], rowCount: 0 };
    }),
  };
  return { client, log };
}

describe("SUPPORTED_AUDIT_ENTITY_TYPES", () => {
  it("includes all v0.3 entity types referenced by audit events", () => {
    for (const t of [
      "account",
      "balance",
      "transaction",
      "counterparty",
      "obligation",
      "document",
      "invoice",
      "payment_intent",
      "reconciliation_match",
      "proposal",
      "execution",
    ]) {
      expect(SUPPORTED_AUDIT_ENTITY_TYPES).toContain(t);
    }
  });
});

describe("findEventsByEntity", () => {
  it("returns [] without querying for unknown entity types", async () => {
    const { client, log } = fakeClient();
    const rows = await findEventsByEntity(client, "unknown_type", "x_123", 10);
    expect(rows).toEqual([]);
    expect(log.length).toBe(0);
  });

  it("queries inputs->>'transaction_id' OR outputs->>'transaction_id' for transaction", async () => {
    const { client, log } = fakeClient();
    await findEventsByEntity(client, "transaction", "tx_01HQ7K3", 100);
    expect(log).toHaveLength(1);
    const sql = log[0]!.sql;
    expect(sql).toContain("(inputs->>'transaction_id') = $1");
    expect(sql).toContain("(outputs->>'transaction_id') = $1");
    expect(log[0]!.values).toEqual(["tx_01HQ7K3", 100]);
  });

  it("payment_intent also predicates on policy_decision_id", async () => {
    const { client, log } = fakeClient();
    await findEventsByEntity(client, "payment_intent", "pi_abc", 50);
    expect(log[0]!.sql).toContain("(inputs->>'payment_intent_id') = $1");
    expect(log[0]!.sql).toContain("policy_decision_id = $1");
  });

  it("orders chronologically (asc) so callers see the timeline", async () => {
    const { client, log } = fakeClient();
    await findEventsByEntity(client, "account", "acct_1", 10);
    expect(log[0]!.sql).toMatch(/ORDER BY created_at ASC/);
  });
});
